const chai = require('chai')
const expect = chai.expect
const sinon = require('sinon')
const rewire = require('rewire')
const fs = require('fs')
const os = require('os')
const Path = require('path')

/**
 * Regression + positive tests for the inode-match guards in LibraryScanner.
 *
 * Issue: https://github.com/advplyr/audiobookshelf/issues/5010
 *
 * The three private helpers in LibraryScanner.js use inode equality to detect
 * "this library item moved" during a scan. None of them verify that the matched
 * library item's original path is actually gone — so when the filesystem reuses
 * a freed inode (normal allocator behavior after a file is replaced/deleted),
 * the helpers mistake the coincidence for a folder move and partial-update the
 * existing record, corrupting cover/chapter/date metadata.
 *
 * For each of the three helpers we have two tests:
 *
 *   - REGRESSION: stale-inode coincidence with the original path STILL on disk.
 *       Currently fails (returns the wrong item). Should pass with the guard
 *       (returns null, treats the new folder as a fresh item).
 *
 *   - POSITIVE: stale-inode match with the original path GONE — i.e., the
 *       legitimate "folder was renamed/moved" case the inode-match feature was
 *       designed for. Must continue to return the matched item with or without
 *       the guard.
 */
describe('LibraryScanner — inode-match guards on inode reuse', () => {
  let LibraryScanner
  let tempDirsToCleanup

  beforeEach(() => {
    LibraryScanner = rewire('../../../server/scanner/LibraryScanner')
    tempDirsToCleanup = []
  })

  afterEach(() => {
    sinon.restore()
    for (const dir of tempDirsToCleanup) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // ----- helpers ---------------------------------------------------------

  /** Create a real temp dir/file on disk (registered for cleanup) and return its absolute path. */
  function makeExistingPath({ asFile = false } = {}) {
    const p = Path.join(os.tmpdir(), `abs-test-${Date.now()}-${Math.random().toString(36).slice(2)}${asFile ? '.m4b' : ''}`)
    if (asFile) {
      fs.writeFileSync(p, '')
    } else {
      fs.mkdirSync(p, { recursive: true })
    }
    tempDirsToCleanup.push(p)
    return p
  }

  /** Return an absolute path that does NOT exist on disk. */
  function makeMissingPath({ asFile = false } = {}) {
    return Path.join(os.tmpdir(), `abs-test-missing-${Date.now()}-${Math.random().toString(36).slice(2)}${asFile ? '.m4b' : ''}`)
  }

  /** Replace LibraryScanner's `Database` reference with a stub that returns `fakeItem` from findOneExpanded. */
  function installFakeDatabase(fakeItem) {
    const mockDatabase = {
      libraryItemModel: {
        findOneExpanded: sinon.stub().resolves(fakeItem)
      }
    }
    LibraryScanner.__set__('Database', mockDatabase)
    return mockDatabase
  }

  /** Replace LibraryScanner's `fileUtils` reference with a stub whose `getIno` calls `getInoFn(filePath)`. */
  function installFakeFileUtils(getInoFn) {
    const mockFileUtils = {
      getIno: sinon.stub().callsFake(async (filePath) => getInoFn(filePath))
    }
    LibraryScanner.__set__('fileUtils', mockFileUtils)
  }

  // ----- findLibraryItemByFileToItemInoMatch ------------------------------
  //
  // Used when scanning a multi-file folder. Walks each itemFile, looks up its
  // inode, and checks whether any library item's `ino` matches one of them.

  describe('findLibraryItemByFileToItemInoMatch', () => {
    it('REGRESSION: should reject the match when the matched library item\'s original path still exists on disk (inode-reuse coincidence)', async () => {
      const fn = LibraryScanner.__get__('findLibraryItemByFileToItemInoMatch')

      const COLLIDING_INO = 12345
      const existingItemPath = makeExistingPath()  // real dir, exists on disk

      installFakeFileUtils((filePath) => filePath.endsWith('/cover.jpg') ? COLLIDING_INO : 99999)
      installFakeDatabase({
        id: 'existing-item-id',
        path: existingItemPath,
        ino: COLLIDING_INO,
        libraryFiles: [],
        media: { title: 'Some Existing Book' }
      })

      const result = await fn('library-id', '/audiobooks/Some Author/New Book', false, ['cover.jpg', 'audio.m4b'])

      expect(fs.existsSync(existingItemPath)).to.be.true   // sanity: still on disk
      expect(result).to.be.null                            // should reject the coincidence
    })

    it('POSITIVE: should accept the match when the matched library item\'s original path is gone (legitimate folder move)', async () => {
      const fn = LibraryScanner.__get__('findLibraryItemByFileToItemInoMatch')

      const COLLIDING_INO = 12345
      const existingItemPath = makeMissingPath()  // never created — represents "folder was moved away"

      installFakeFileUtils((filePath) => filePath.endsWith('/cover.jpg') ? COLLIDING_INO : 99999)
      installFakeDatabase({
        id: 'moved-item-id',
        path: existingItemPath,
        ino: COLLIDING_INO,
        libraryFiles: [],
        media: { title: 'Moved Book' }
      })

      const result = await fn('library-id', '/audiobooks/Some Author/New Path', false, ['cover.jpg', 'audio.m4b'])

      expect(fs.existsSync(existingItemPath)).to.be.false  // sanity: original is gone
      expect(result).to.not.be.null
      expect(result.id).to.equal('moved-item-id')
    })
  })

  // ----- findLibraryItemByItemToItemInoMatch ------------------------------
  //
  // Used when scanning a folder whose inode itself matches an existing library
  // item's `ino`. Single inode lookup (the folder's own inode).

  describe('findLibraryItemByItemToItemInoMatch', () => {
    it('REGRESSION: should reject the match when the matched library item\'s original path still exists on disk (inode-reuse coincidence)', async () => {
      const fn = LibraryScanner.__get__('findLibraryItemByItemToItemInoMatch')

      const COLLIDING_INO = 23456
      const existingItemPath = makeExistingPath()

      installFakeFileUtils(() => COLLIDING_INO)  // the new folder happens to have this inode
      installFakeDatabase({
        id: 'existing-item-id',
        path: existingItemPath,
        ino: COLLIDING_INO,
        libraryFiles: [],
        media: { title: 'Some Existing Book' }
      })

      const result = await fn('library-id', '/audiobooks/Some Author/New Folder')

      expect(fs.existsSync(existingItemPath)).to.be.true
      expect(result).to.be.null
    })

    it('POSITIVE: should accept the match when the matched library item\'s original path is gone (legitimate folder move)', async () => {
      const fn = LibraryScanner.__get__('findLibraryItemByItemToItemInoMatch')

      const COLLIDING_INO = 23456
      const existingItemPath = makeMissingPath()

      installFakeFileUtils(() => COLLIDING_INO)
      installFakeDatabase({
        id: 'moved-item-id',
        path: existingItemPath,
        ino: COLLIDING_INO,
        libraryFiles: [],
        media: { title: 'Moved Book' }
      })

      const result = await fn('library-id', '/audiobooks/Some Author/New Path')

      expect(fs.existsSync(existingItemPath)).to.be.false
      expect(result).to.not.be.null
      expect(result.id).to.equal('moved-item-id')
    })
  })

  // ----- findLibraryItemByItemToFileInoMatch ------------------------------
  //
  // Used for SINGLE-MEDIA items (a bare audio file as the library item).
  // Compares the file's inode against library items' libraryFiles[].ino.
  // The function early-returns null unless isSingleMedia is true.

  describe('findLibraryItemByItemToFileInoMatch', () => {
    it('REGRESSION: should reject the match when the matched library item\'s original path still exists on disk (inode-reuse coincidence)', async () => {
      const fn = LibraryScanner.__get__('findLibraryItemByItemToFileInoMatch')

      const COLLIDING_INO = 34567
      const existingItemPath = makeExistingPath({ asFile: true })  // real file, exists

      installFakeFileUtils(() => COLLIDING_INO)
      installFakeDatabase({
        id: 'existing-item-id',
        path: existingItemPath,
        libraryFiles: [{ ino: COLLIDING_INO, metadata: { path: existingItemPath } }],
        media: { title: 'Some Existing Audiobook' }
      })

      const result = await fn('library-id', '/audiobooks/New Bare Audio.m4b', true)

      expect(fs.existsSync(existingItemPath)).to.be.true
      expect(result).to.be.null
    })

    it('POSITIVE: should accept the match when the matched library item\'s original path is gone (legitimate file move)', async () => {
      const fn = LibraryScanner.__get__('findLibraryItemByItemToFileInoMatch')

      const COLLIDING_INO = 34567
      const existingItemPath = makeMissingPath({ asFile: true })

      installFakeFileUtils(() => COLLIDING_INO)
      installFakeDatabase({
        id: 'moved-item-id',
        path: existingItemPath,
        libraryFiles: [{ ino: COLLIDING_INO, metadata: { path: existingItemPath } }],
        media: { title: 'Moved Audiobook' }
      })

      const result = await fn('library-id', '/audiobooks/New Bare Audio.m4b', true)

      expect(fs.existsSync(existingItemPath)).to.be.false
      expect(result).to.not.be.null
      expect(result.id).to.equal('moved-item-id')
    })
  })
})

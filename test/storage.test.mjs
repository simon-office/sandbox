import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openStorage } from '../dist/storage/index.js';

test('storage migrates an empty file and persists listings, observations, searches, notes and watch state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imoti-storage-'));
  const storage = openStorage(join(dir, 'nested', 'imoti.db'));
  try {
    const listing = { id: 'site-1', propertyKey: null, title: 'Fake flat', price: 123, location: { precision: 'street', name: 'Imaginary Rd' } };
    storage.upsertListing(listing, '2026-01-01T00:00:00.000Z');
    storage.upsertListing({ ...listing, price: 120 }, '2026-01-02T00:00:00.000Z');
    assert.deepEqual(storage.getListing('site-1'), { ...listing, price: 120, firstObservedAt: '2026-01-01T00:00:00.000Z', lastObservedAt: '2026-01-02T00:00:00.000Z' });
    const observation = { listingId: 'site-1', observedAt: '2026-01-02T00:00:00.000Z', sourceUrl: 'https://example.invalid/fake', raw: { amount: '120' }, normalized: { price: 120 } };
    storage.recordObservation(observation);
    storage.recordObservation(observation);
    assert.deepEqual(storage.listObservations('site-1'), [observation]);
    storage.saveSearch({ id: 's1', criteria: { city: 'Sofia' }, createdAt: '2026-01-02T00:00:00.000Z' });
    assert.deepEqual(storage.listSearches(), [{ id: 's1', criteria: { city: 'Sofia' }, createdAt: '2026-01-02T00:00:00.000Z' }]);
    storage.addNote({ id: 'n1', listingId: 'site-1', kind: 'note', text: 'Ask about heating', createdAt: '2026-01-02T00:00:00.000Z' });
    assert.deepEqual(storage.listNotes('site-1'), [{ id: 'n1', listingId: 'site-1', kind: 'note', text: 'Ask about heating', createdAt: '2026-01-02T00:00:00.000Z' }]);
    storage.watch('site-1');
    storage.watch('site-1');
    assert.deepEqual(storage.listWatched(), ['site-1']);
    storage.unwatch('site-1');
    assert.deepEqual(storage.listWatched(), []);
    storage.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('storage defaults database path beneath IMOTI_DATA_DIR and rejects unsupported location precision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imoti-storage-'));
  const previous = process.env.IMOTI_DATA_DIR;
  process.env.IMOTI_DATA_DIR = dir;
  try {
    const storage = openStorage();
    assert.throws(() => storage.upsertListing({ id: 'bad', location: { precision: 'city' } }));
    storage.close();
  } finally {
    if (previous === undefined) delete process.env.IMOTI_DATA_DIR;
    else process.env.IMOTI_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('site listing ids remain distinct when they share a physical property key and event kinds are constrained', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imoti-storage-'));
  const path = join(dir, 'imoti.db');
  const storage = openStorage(path);
  try {
    storage.upsertListing({ id: 'site-a', propertyKey: 'building-7' });
    storage.upsertListing({ id: 'site-b', propertyKey: 'building-7' });
    assert.equal(storage.getListing('site-a').id, 'site-a');
    assert.equal(storage.getListing('site-b').id, 'site-b');
  } finally {
    storage.close();
  }
  const db = new DatabaseSync(path);
  try {
    assert.throws(() => db.prepare("INSERT INTO events(listing_id, kind, occurred_at, event_json) VALUES ('site-a', 'unknown', 'now', '{}')").run());
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('watching an unknown listing does not create placeholder observation timestamps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imoti-storage-'));
  const storage = openStorage(join(dir, 'imoti.db'));
  try {
    storage.watch('site-later');
    assert.equal(storage.getListing('site-later'), undefined);
    storage.upsertListing({ id: 'site-later', title: 'Real listing' }, '2026-02-01T00:00:00.000Z');
    assert.deepEqual(storage.getListing('site-later'), {
      id: 'site-later', title: 'Real listing',
      firstObservedAt: '2026-02-01T00:00:00.000Z', lastObservedAt: '2026-02-01T00:00:00.000Z',
    });
    assert.deepEqual(storage.listWatched(), ['site-later']);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('observations update latest normalized listing values and observation timestamps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imoti-storage-'));
  const storage = openStorage(join(dir, 'imoti.db'));
  try {
    storage.recordObservation({ listingId: 'site-obs', observedAt: '2026-03-01T00:00:00.000Z', sourceUrl: 'https://example.invalid/one', raw: { price: '100' }, normalized: { title: 'First', price: 100 } });
    storage.recordObservation({ listingId: 'site-obs', observedAt: '2026-03-02T00:00:00.000Z', sourceUrl: 'https://example.invalid/two', raw: { price: '90' }, normalized: { title: 'Updated', price: 90 } });
    assert.deepEqual(storage.getListing('site-obs'), {
      id: 'site-obs', title: 'Updated', price: 90,
      firstObservedAt: '2026-03-01T00:00:00.000Z', lastObservedAt: '2026-03-02T00:00:00.000Z',
    });
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('duplicate observation replays cannot mutate the listing snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imoti-storage-'));
  const path = join(dir, 'imoti.db');
  let storage = openStorage(path);
  try {
    const observation = { listingId: 'site-replay', observedAt: '2026-07-01T00:00:00.000Z', sourceUrl: 'https://example.invalid/replay', raw: { price: '100' }, normalized: { title: 'Original', price: 100, propertyKey: 'original-property' } };
    storage.recordObservation(observation);
    const listing = storage.getListing('site-replay');
    storage.recordObservation({ ...observation, raw: { price: '50' }, normalized: { title: 'Discarded replay', price: 50, propertyKey: 'different-property' } });
    assert.deepEqual(storage.getListing('site-replay'), listing);
    assert.deepEqual(storage.listObservations('site-replay'), [observation]);
    storage.close();
    storage = openStorage(path);
    assert.deepEqual(storage.getListing('site-replay'), listing);
    assert.deepEqual(storage.listObservations('site-replay'), [observation]);
    const distinctObservation = { ...observation, sourceUrl: 'https://example.invalid/distinct', normalized: { title: 'Distinct source', price: 90 } };
    storage.recordObservation(distinctObservation);
    assert.equal(storage.getListing('site-replay').price, 90);
    assert.deepEqual(storage.listObservations('site-replay'), [observation, distinctObservation]);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed observation write leaves no listing changes or partial history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imoti-storage-'));
  const storage = openStorage(join(dir, 'imoti.db'));
  try {
    storage.upsertListing({ id: 'site-failed-write', title: 'Original', price: 100 }, '2026-07-01T00:00:00.000Z');
    const listing = storage.getListing('site-failed-write');
    const observation = { listingId: 'site-failed-write', observedAt: '2026-07-02T00:00:00.000Z', sourceUrl: 'https://example.invalid/failed-write', raw: { unsupported: 1n }, normalized: { title: 'Unstored', price: 50 } };
    assert.throws(() => storage.recordObservation(observation), /BigInt/);
    assert.deepEqual(storage.getListing('site-failed-write'), listing);
    assert.deepEqual(storage.listObservations('site-failed-write'), []);
    assert.throws(() => storage.recordObservation({ ...observation, listingId: 'site-invalid-location', raw: {}, normalized: { location: { precision: 'city' } } }), /Invalid location precision/);
    assert.equal(storage.getListing('site-invalid-location'), undefined);
    assert.deepEqual(storage.listObservations('site-invalid-location'), []);
    const valid = { ...observation, raw: { price: '50' } };
    storage.recordObservation(valid);
    assert.equal(storage.getListing('site-failed-write').price, 50);
    assert.deepEqual(storage.listObservations('site-failed-write'), [valid]);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('opening a newer schema fails without modifying its schema or version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imoti-storage-'));
  const path = join(dir, 'imoti.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES (2);');
  db.close();
  try {
    assert.throws(() => openStorage(path), /newer than supported/);
    const reopened = new DatabaseSync(path);
    try {
      assert.equal(reopened.prepare('SELECT version FROM schema_version').get().version, 2);
      assert.deepEqual(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name), ['schema_version']);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('observations keep the authoritative listing id and existing property key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imoti-storage-'));
  const storage = openStorage(join(dir, 'imoti.db'));
  try {
    storage.upsertListing({ id: 'site-authoritative', propertyKey: 'property-known', title: 'Initial' }, '2026-04-01T00:00:00.000Z');
    storage.recordObservation({ listingId: 'site-authoritative', observedAt: '2026-04-02T00:00:00.000Z', sourceUrl: 'https://example.invalid/id', raw: {}, normalized: { id: 'conflicting-id', title: 'Updated' } });
    assert.equal(storage.getListing('site-authoritative').id, 'site-authoritative');
    assert.equal(storage.getListing('site-authoritative').propertyKey, 'property-known');
    assert.equal(storage.getListing('conflicting-id'), undefined);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('older observations do not regress latest listing values or timestamps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imoti-storage-'));
  const storage = openStorage(join(dir, 'imoti.db'));
  try {
    storage.recordObservation({ listingId: 'site-stale', observedAt: '2026-05-02T00:00:00.000Z', sourceUrl: 'https://example.invalid/new', raw: {}, normalized: { title: 'New', price: 90 } });
    storage.recordObservation({ listingId: 'site-stale', observedAt: '2026-05-01T00:00:00.000Z', sourceUrl: 'https://example.invalid/old', raw: {}, normalized: { title: 'Old', price: 100 } });
    assert.deepEqual(storage.getListing('site-stale'), { id: 'site-stale', title: 'New', price: 90, firstObservedAt: '2026-05-02T00:00:00.000Z', lastObservedAt: '2026-05-02T00:00:00.000Z' });
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('schema version zero upgrades through the ordered migration to version one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imoti-storage-'));
  const path = join(dir, 'imoti.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES (0);');
  db.close();
  try {
    const storage = openStorage(path);
    storage.upsertListing({ id: 'after-migration' });
    assert.equal(storage.getListing('after-migration').id, 'after-migration');
    storage.close();
    const migrated = new DatabaseSync(path);
    try { assert.equal(migrated.prepare('SELECT version FROM schema_version').get().version, 1); }
    finally { migrated.close(); }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a null observation property key preserves known identity without changing the snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imoti-storage-'));
  const path = join(dir, 'imoti.db');
  const storage = openStorage(path);
  try {
    storage.upsertListing({ id: 'site-null-key', propertyKey: 'known-property' }, '2026-06-01T00:00:00.000Z');
    const observation = { listingId: 'site-null-key', observedAt: '2026-06-02T00:00:00.000Z', sourceUrl: 'https://example.invalid/null-key', raw: {}, normalized: { propertyKey: null, price: 80 } };
    storage.recordObservation(observation);
    assert.equal(storage.getListing('site-null-key').propertyKey, 'known-property');
    assert.equal(storage.getListing('site-null-key').price, 80);
    assert.deepEqual(storage.listObservations('site-null-key'), [observation]);
    const db = new DatabaseSync(path);
    try {
      assert.equal(db.prepare('SELECT property_key FROM listings WHERE id = ?').get('site-null-key').property_key, 'known-property');
    } finally { db.close(); }
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('notes reject missing and unsupported kinds before writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imoti-storage-'));
  const storage = openStorage(join(dir, 'imoti.db'));
  try {
    storage.upsertListing({ id: 'site-notes' });
    const note = { id: 'invalid-note', listingId: 'site-notes', text: 'Fake note', createdAt: '2026-06-01T00:00:00.000Z' };
    for (const kind of [undefined, null, '', 'favorite', 'unsupported']) {
      assert.throws(() => storage.addNote({ ...note, kind }), /Invalid note kind/);
    }
    assert.deepEqual(storage.listNotes('site-notes'), []);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy untyped notes are read as plain notes without losing their values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imoti-storage-'));
  const path = join(dir, 'imoti.db');
  const storage = openStorage(path);
  try {
    storage.upsertListing({ id: 'legacy-listing' });
    const legacy = { id: 'legacy-note', listingId: 'legacy-listing', text: 'Invented old note', createdAt: '2026-06-01T00:00:00.000Z', extra: { preserved: true } };
    const db = new DatabaseSync(path);
    try {
      db.prepare('INSERT INTO notes(id, listing_id, note_json) VALUES (?, ?, ?)').run(legacy.id, legacy.listingId, JSON.stringify(legacy));
    } finally { db.close(); }
    assert.deepEqual(storage.listNotes('legacy-listing'), [{ ...legacy, kind: 'note' }]);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('all supported note kinds persist across reopen and equivalent writes do not duplicate notes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imoti-storage-'));
  const path = join(dir, 'imoti.db');
  let storage = openStorage(path);
  try {
    storage.upsertListing({ id: 'site-note-kinds' });
    const notes = ['favourite', 'rejected', 'viewing', 'note'].map(kind => ({ id: `note-${kind}`, listingId: 'site-note-kinds', kind, text: `Invented ${kind}`, createdAt: '2026-06-01T00:00:00.000Z' }));
    for (const note of notes) {
      storage.addNote(note);
      storage.addNote(note);
    }
    storage.close();
    storage = openStorage(path);
    assert.deepEqual(storage.listNotes('site-note-kinds'), notes);
    assert.deepEqual(storage.listNotes('another-listing'), []);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Storage driver tests (spec section 19).
 *
 * These exercise the two defences at the layer where they can actually be
 * reached. A path-traversal key cannot be delivered over HTTP — multipart
 * encoders strip directory components before the request is sent — but the
 * driver must still refuse one, because a future caller could construct a key
 * from somewhere other than an upload.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config/env.js';
import { detectFileType, storage } from '../../src/core/storage.js';
import { AppError } from '../../src/http/errors.js';

describe('detectFileType', () => {
  it('identifies the accepted types by their leading bytes', () => {
    const cases: Array<[string, Buffer, string]> = [
      ['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'image/jpeg'],
      [
        'png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
        'image/png',
      ],
      [
        'webp',
        Buffer.concat([
          Buffer.from('RIFF'),
          Buffer.alloc(4),
          Buffer.from('WEBP'),
          Buffer.alloc(4),
        ]),
        'image/webp',
      ],
      [
        'mp4',
        Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(8)]),
        'video/mp4',
      ],
    ];

    for (const [label, bytes, expected] of cases) {
      expect(detectFileType(bytes).mimeType, label).toBe(expected);
    }
  });

  it('rejects a file whose contents contradict its extension', () => {
    /* The whole point of sniffing: a client can label anything `image/jpeg`,
       so only the bytes are evidence. */
    expect(() => detectFileType(Buffer.from('#!/bin/sh\necho hi\n'))).toThrow(AppError);
    expect(() => detectFileType(Buffer.from('%PDF-1.4'))).toThrow(AppError);
    expect(() => detectFileType(Buffer.from('<?php system($_GET[0]); ?>'))).toThrow(
      AppError,
    );
  });

  it('rejects a file too short to carry a signature', () => {
    expect(() => detectFileType(Buffer.from([0xff]))).toThrow(AppError);
    expect(() => detectFileType(Buffer.alloc(0))).toThrow(AppError);
  });

  it('is not fooled by a signature appearing later in the file', () => {
    /* JPEG's marker must be at offset 0. Finding it further in means the file
       is something else that happens to contain those bytes. */
    const disguised = Buffer.concat([
      Buffer.from('GIF89a'),
      Buffer.from([0xff, 0xd8, 0xff]),
    ]);

    expect(() => detectFileType(disguised)).toThrow(AppError);
  });
});

describe('local storage driver', () => {
  it('writes under the configured root with a generated key', async () => {
    const stored = await storage().save(Buffer.from([0xff, 0xd8, 0xff, 0x01]), {
      complaintId: '6aa7f6198e78f5efbb663a26',
      extension: 'jpg',
      mimeType: 'image/jpeg',
    });

    expect(stored.storageKey).toMatch(
      /^complaints\/6aa7f6198e78f5efbb663a26\/[0-9a-f-]{36}\.jpg$/,
    );
    expect(stored.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.sizeBytes).toBe(4);

    const onDisk = await fs.readFile(
      path.join(config.STORAGE_LOCAL_PATH, stored.storageKey),
    );
    expect(onDisk.length).toBe(4);

    await storage().remove(stored.storageKey);
  });

  it('refuses a key that escapes the storage root', async () => {
    /**
     * Keys are generated, so this should be unreachable in practice. It is
     * guarded anyway because it is the last check between a string and the
     * file system, and the cost of being wrong is reading or writing
     * arbitrary files on the host.
     */
    for (const escaping of [
      '../secrets.env',
      'complaints/../../etc/passwd',
      '../../../../../../etc/passwd',
    ]) {
      await expect(storage().read(escaping)).rejects.toThrow(/Invalid storage key/);
      await expect(storage().remove(escaping)).rejects.toThrow(/Invalid storage key/);
    }
  });

  it('reports a missing file rather than inventing one', async () => {
    await expect(
      storage().read('complaints/6aa7f6198e78f5efbb663a26/nope.jpg'),
    ).rejects.toThrow();

    expect(await storage().exists('complaints/nothing/here.jpg')).toBe(false);
  });

  it('gives identical bytes an identical checksum', async () => {
    /* What makes the duplicate-upload check work. */
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x42]);

    const first = await storage().save(bytes, {
      complaintId: '6aa7f6198e78f5efbb663a26',
      extension: 'jpg',
      mimeType: 'image/jpeg',
    });
    const second = await storage().save(bytes, {
      complaintId: '6aa7f6198e78f5efbb663a26',
      extension: 'jpg',
      mimeType: 'image/jpeg',
    });

    expect(first.checksum).toBe(second.checksum);
    /* Different keys, though — the driver stores what it is given and leaves
       de-duplication to the layer that knows about complaints. */
    expect(first.storageKey).not.toBe(second.storageKey);

    await storage().remove(first.storageKey);
    await storage().remove(second.storageKey);
  });
});

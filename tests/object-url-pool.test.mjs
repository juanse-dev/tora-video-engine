import assert from "node:assert/strict";
import {test} from "node:test";
import {ObjectUrlPool} from "../src/web/objectUrlPool.ts";

const createPool = () => {
  const created = [];
  const revoked = [];
  const pool = new ObjectUrlPool({
    create: (blob) => {
      const url = `blob:test/${created.length}`;

      created.push({url, blob});

      return url;
    },
    revoke: (url) => revoked.push(url),
  });

  return {pool, created, revoked};
};

test("the same digest acquired twice shares one URL and is revoked after two releases", () => {
  const {pool, created, revoked} = createPool();
  const blob = new Blob(["a"]);
  const first = pool.acquire("d1", blob);
  const second = pool.acquire("d1", blob);

  assert.equal(first, second);
  assert.equal(created.length, 1);
  assert.equal(created[0].blob, blob);

  pool.release("d1");
  assert.deepEqual(revoked, []);

  pool.release("d1");
  assert.deepEqual(revoked, [first]);
});

test("a digest acquired again after its last release gets a new URL", () => {
  const {pool, created} = createPool();
  const first = pool.acquire("d1", new Blob(["a"]));

  pool.release("d1");

  const second = pool.acquire("d1", new Blob(["a"]));

  assert.notEqual(first, second);
  assert.equal(created.length, 2);
});

test("different digests get different URLs", () => {
  const {pool} = createPool();

  assert.notEqual(
    pool.acquire("d1", new Blob(["a"])),
    pool.acquire("d2", new Blob(["b"])),
  );
});

test("dispose revokes every URL and later releases are no-ops", () => {
  const {pool, revoked} = createPool();
  const one = pool.acquire("d1", new Blob(["a"]));
  const two = pool.acquire("d2", new Blob(["b"]));

  pool.acquire("d2", new Blob(["b"]));
  pool.dispose();

  assert.deepEqual([...revoked].sort(), [one, two].sort());

  pool.release("d1");
  pool.release("d2");
  assert.equal(revoked.length, 2);
});

test("releasing an unknown digest is a no-op", () => {
  const {pool, revoked} = createPool();

  pool.release("never-acquired");
  assert.deepEqual(revoked, []);
});

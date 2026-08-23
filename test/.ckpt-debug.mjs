class FakeRequest {
  constructor(runner, tx) {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    queueMicrotask(() => {
      try { this.result = runner(); this.onsuccess?.(); }
      catch (e) { this.error = e; this.onerror?.(); }
      finally { if (tx) { tx.pending--; queueMicrotask(() => tx.tryFinish()); } }
    });
  }
}
class FakeObjectStore {
  constructor(data, keys, tx) { this.data = data; this.keys = keys; this.tx = tx; }

(Showing lines 3-17 of 71. Use offset=18 to continue.)


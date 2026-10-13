// Storage backends with one shared interface:
//   subscribe(tripId, cb)            cb({ trip, expenses }) on every change; returns unsubscribe
//   createTrip(trip)                 -> tripId
//   updateTrip(tripId, patch)        shallow fields (name, settleCurrency, rates)
//   setPerson(tripId, id, person) / removePerson(tripId, id)
//   saveExpense(tripId, expense) / deleteExpense(tripId, id)
// Writes are fire-and-forget so the UI never waits on the network; Firestore
// queues them while offline and the subscription reflects them immediately.

import { firebaseConfig } from './config.js';

export function newId(len = 12) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export async function openStore(onError) {
  if (firebaseConfig) {
    try {
      return await firestoreStore(firebaseConfig, onError);
    } catch (err) {
      console.error(err);
      onError?.(err);
    }
  }
  return localStore();
}

// ---------- Local (this browser only) ----------

function localStore() {
  const key = (id) => `split:trip:${id}`;
  const listeners = new Map(); // tripId -> Set<cb>

  const mem = {}; // fallback when localStorage is blocked (private mode, sandboxed frames)
  const read = (id) => {
    try {
      return mem[id] ?? JSON.parse(localStorage.getItem(key(id)));
    } catch {
      return mem[id] ?? null;
    }
  };
  const emit = (id) => {
    const data = read(id);
    const state = data
      ? { trip: data.trip, expenses: Object.values(data.expenses) }
      : { trip: null, expenses: [] };
    listeners.get(id)?.forEach((cb) => cb(state));
  };
  const write = (id, fn) => {
    const data = read(id) || { trip: null, expenses: {} };
    fn(data);
    mem[id] = data;
    try { localStorage.setItem(key(id), JSON.stringify(data)); } catch { /* keep in memory */ }
    emit(id);
  };

  // Keep other tabs in sync.
  window.addEventListener('storage', (e) => {
    const m = e.key?.match(/^split:trip:(.+)$/);
    if (m) emit(m[1]);
  });

  return {
    shared: false,
    subscribe(id, cb) {
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id).add(cb);
      queueMicrotask(() => emit(id));
      return () => listeners.get(id).delete(cb);
    },
    createTrip(trip) {
      const id = newId();
      write(id, (d) => { d.trip = { ...trip, createdAt: Date.now() }; });
      return id;
    },
    updateTrip(id, patch) {
      write(id, (d) => Object.assign(d.trip, patch));
    },
    setPerson(id, pid, person) {
      write(id, (d) => { d.trip.people = { ...d.trip.people, [pid]: person }; });
    },
    removePerson(id, pid) {
      write(id, (d) => { delete d.trip.people[pid]; });
    },
    saveExpense(id, e) {
      write(id, (d) => { d.expenses[e.id] = { ...e, updatedAt: Date.now() }; });
    },
    deleteExpense(id, eid) {
      write(id, (d) => { delete d.expenses[eid]; });
    },
  };
}

// ---------- Firestore (shared + realtime) ----------
//   trips/{tripId}                  { name, settleCurrency, rates, people: { [pid]: {name, order} } }
//   trips/{tripId}/expenses/{id}    one doc per expense, so concurrent edits don't clobber

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

async function firestoreStore(config, onError) {
  const [{ initializeApp }, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = initializeApp(config);
  let db;
  try {
    // Persistent cache = works offline and loads instantly on reopen.
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
      ignoreUndefinedProperties: true,
    });
  } catch {
    db = fs.getFirestore(app);
  }
  if (config.emulatorHost) {
    const [host, port] = config.emulatorHost.split(':');
    fs.connectFirestoreEmulator(db, host, Number(port));
  }

  const tripRef = (id) => fs.doc(db, 'trips', id);
  const expRef = (id, eid) => fs.doc(db, 'trips', id, 'expenses', eid);
  const fail = (p) => p.catch((err) => { console.error(err); onError?.(err); });

  return {
    shared: true,
    subscribe(id, cb) {
      let trip;
      let expenses;
      const push = () => {
        if (trip !== undefined && expenses !== undefined) cb({ trip, expenses });
      };
      const u1 = fs.onSnapshot(tripRef(id), (s) => {
        // A cache miss on a link we've never opened isn't "not found" yet.
        if (!s.exists() && s.metadata.fromCache) return;
        trip = s.exists() ? s.data() : null;
        push();
      }, onError);
      const u2 = fs.onSnapshot(fs.collection(db, 'trips', id, 'expenses'), (s) => {
        expenses = s.docs.map((d) => ({ ...d.data(), id: d.id }));
        push();
      }, onError);
      return () => { u1(); u2(); };
    },
    createTrip(trip) {
      const id = newId();
      fail(fs.setDoc(tripRef(id), { ...trip, createdAt: Date.now() }));
      return id;
    },
    updateTrip(id, patch) {
      fail(fs.updateDoc(tripRef(id), patch));
    },
    setPerson(id, pid, person) {
      fail(fs.updateDoc(tripRef(id), { [`people.${pid}`]: person }));
    },
    removePerson(id, pid) {
      fail(fs.updateDoc(tripRef(id), { [`people.${pid}`]: fs.deleteField() }));
    },
    saveExpense(id, e) {
      fail(fs.setDoc(expRef(id, e.id), { ...e, updatedAt: Date.now() }));
    },
    deleteExpense(id, eid) {
      fail(fs.deleteDoc(expRef(id, eid)));
    },
  };
}

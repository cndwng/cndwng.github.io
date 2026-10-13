# split

Trip expense splitter at [cndwng.com/split](https://cndwng.com/split/). Plain HTML/JS, no build step.

- `settle.js`: money math (currencies, splits, balances, fewest-payments settle-up). No DOM, so it's testable in node.
- `store.js`: storage. Uses Firestore when `config.js` has a config, otherwise localStorage.
- `app.js`: UI.
- `firestore.rules`: security rules to paste into Firebase.

## Turn on sharing (one time, ~5 min)

Without this the app runs local-only: it works, but trips live in one browser and links won't open for friends.

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Create a project** (Analytics can be off; it's free on the Spark plan).
2. **Build → Firestore Database → Create database**. Pick any region and start in **production mode**.
3. In the Firestore **Rules** tab, replace everything with the contents of `firestore.rules` → **Publish**.
4. **Project settings (gear) → Your apps → Web (`</>`)** → register an app (no Hosting needed). Copy the `firebaseConfig` object it shows.
5. Paste it into `config.js`:
   ```js
   export const firebaseConfig = {
     apiKey: '…',
     authDomain: '….firebaseapp.com',
     projectId: '…',
     storageBucket: '…',
     messagingSenderId: '…',
     appId: '…',
   };
   ```
6. Commit and push. The web config isn't a secret; it's meant to ship in client code. Access is controlled by the rules.

## How sharing works

A trip's id is in its link (`/split/?t=…`). Anyone with the link can view and edit that trip. Nobody can list trips, so ids can't be discovered. There are no accounts. "Who are you?" is remembered per device and only sets the default payer.

Firestore caches locally, so the app works offline (e.g. on the subway) and syncs when it's back online.

## Links

- `?t=<tripId>` opens a trip (this is the share link).
- Add a hash to open a screen directly: `#add` (new-expense sheet), `#edit-<expenseId>`, `#settle`, `#trip`. No hash = expense list.

## Notes

- Amounts are stored as integers in each currency's smallest unit (cents, yen).
- Each trip has one exchange rate (editable in Trip; "Use today's rate" fetches it). Balances are converted at that rate, so changing it re-prices the whole trip.
- To add a currency: add it to `CURRENCIES` and `DEFAULT_RATES` in `settle.js`.
- Settle-up is exactly minimal: n people need n − k payments, where k is the most groups whose balances each sum to zero. It uses a subset DP for up to 18 people with nonzero balances, then falls back to greedy.

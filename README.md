# BeXT

Upload your bank statements (CSV or OFX/QFX), let keyword rules categorize every transaction, and see where the money goes — lists, graphs, a monthly P&L, transfer reconciliation and data-health checks. Everything runs on your own machine, in a local SQLite file; nothing is sent anywhere unless you turn on the optional AI review with your own provider key.

## What it does

- **Import** bank extracts: CSV through a per-account template you set up once (delimiter, encoding, date format, which columns hold the description and the amount, row filters), or OFX/QFX with no setup at all. Every import is previewed before it lands, deduplicated against earlier imports, and can be rolled back.
- **Categorize** with keywords: a keyword maps words in a description to a category; fuzzy matching tolerates small spelling differences; the longest keyword wins; anything you categorize by hand is locked. Select text in a description to turn it into a keyword in one move.
- **Transactions**: filter, search, group by merchant, split, tag, bulk-categorize.
- **Graphs** and **Explore**: income vs. expenses, categories over time, drill-down by month and category.
- **Budget**: your months as a P&L — income, taxes, committed yearly costs, fixed, periodic and variable costs, one-offs — with means and period totals; spread a big purchase over months.
- **Transfers**: pairs the two legs of a transfer between your accounts, tracks accounts you do not import (an exchange wallet, a broker, a deposit), and lists what has no other side.
- **Health**: finds the mistakes that quietly bend totals — keywords catching the wrong rows, money going the wrong way for its category, broken imports, clutter.
- **Multi-user**: an admin creates accounts; every user's data is separate.

## Requirements

- [Node.js](https://nodejs.org) 20 or newer (developed on 24) and npm.
- macOS or Linux for `./dev.sh`. On Windows, use WSL — or run the two halves by hand (below).

## Run it

```bash
git clone <this repository>
cd <the folder>
./dev.sh
```

`dev.sh` installs the dependencies on first run and starts both halves: the API on port 3001 and the web app on **http://localhost:5173**. Ctrl-C stops both.

Without the script, in two terminals:

```bash
cd server && npm install && npm run dev
cd client && npm install && npm run dev
```

### First login

The first start creates an admin account **`admin` / `admin`** — the app asks you to change the password. As admin, open **Users** and create an account for yourself (there is no public sign-up). Each new user starts with a set of categories and merchant keywords from [`samples/category_seed.json`](samples/category_seed.json), mostly for Polish and Brazilian banks and shops; change them freely on the Categories and Keywords pages.

### Try it with the sample statements

[`samples/`](samples) has **synthetic** statements in the formats of a few real banks (Alior, Revolut, Itaú) — invented people, shops and amounts — to see the importer work before using your own:

1. **Accounts** → add an institution, then an account (with its currency).
2. **Uploads** → pick the account, drop a file. An OFX file (`itau_extrato_sample.ofx`) imports as is; a CSV needs its template once — choose the file and the editor reads its columns and proposes a mapping.

### Your own data

Your database lives in `server/data/bext.db`, and automatic backups in `server/data/backups` — both ignored by git. If you keep statement files inside the project folder, put them in `samples/private/`, which git also ignores. **Never commit a real statement.**

## Configuration

Optional. Copy `server/.env.example` to `server/.env` and fill in what you need:

| Variable | What for |
|---|---|
| `BEXT_SESSION_SECRET` | Signs the login cookie. Set any long random string for anything beyond trying it out. |
| `BEXT_AI_KEY_SECRET` | Encrypts the AI provider keys users save (generated automatically if unset). |
| `BEXT_GEMINI_FREE_KEY` | Offers a free Gemini engine to every user in the AI review. |
| `PORT`, `BEXT_DB_PATH`, `BEXT_BACKUP_DIR` | Move the API port, the database file, the backups. |

The AI review (proposing keyword rules for uncategorized merchants) is optional; each user enters their own provider key under Settings.

## One process, no dev server

```bash
cd client && npm run build
cd ../server && npm start
```

The API then serves the built app itself on **http://localhost:3001**.

## Tests

```bash
cd server && npm test
```

## Keywords and categories

- New users get [`samples/category_seed.json`](samples/category_seed.json) automatically. It has the same shape as **Categories → Export**, so your own export can become the seed for the next user.
- [`samples/keywords.csv`](samples/keywords.csv) holds the same keywords in the format of **Keywords → Import**, to add them to a user who already exists.

## For developers

- Svelte 5 + Vite + Tailwind in `client/`, Node + Express + SQLite (Drizzle ORM) in `server/`, JavaScript throughout, Vitest for tests. No workspace tooling — each folder installs on its own.
- [`CLAUDE.md`](CLAUDE.md) is the full specification: every requirement and every design decision with its reason. [`PLAN.md`](PLAN.md) is the build log.
- Database changes: edit `server/src/db/schema.js`, then `npm run db:generate` in `server/`; migrations apply on start.
- Backups: `npm run db:backup [label]`; restoring is command-line only: `npm run db:restore <file>` (with the server stopped).

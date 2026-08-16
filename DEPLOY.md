# Deploying PayFlow Lab (Path 1: Render + Supabase, free)

Frontend + backend both run from **one Render web service** (the server serves the
built dashboard and the merchant page). **Supabase** provides Postgres. Total cost:
**$0** (with the free-tier caveats noted at the end).

```
[Merchant page / APK]  ──►  [PayFlow on Render]  ──►  [Supabase Postgres]
        every screen also served by the same Render service
```

## 0. Prerequisites
- A **GitHub** account (Render deploys from a repo).
- A **Supabase** account + project (any project; note its DB connection string).
- A **Render** account (free).

## 1. Push the project to GitHub
This folder isn't a git repo yet. From the project root:

```bash
git init
git add .
git commit -m "PayFlow Lab"
git branch -M main
git remote add origin https://github.com/<you>/payflow-lab.git
git push -u origin main
```

`.env` is git-ignored — secrets never get committed.

## 2. Get your Supabase connection string
Supabase dashboard → your project → **Project Settings → Database → Connection string → URI**. It looks like:

```
postgres://postgres:[YOUR-PASSWORD]@db.<ref>.supabase.co:5432/postgres
```

Copy it (with the real password). You'll paste it into Render as `DATABASE_URL`.
No need to create tables yourself — `AUTO_MIGRATE` does it on first boot.

## 3. Deploy on Render (Blueprint)
1. Render → **New → Blueprint** → connect your GitHub repo. Render reads
   [`render.yaml`](render.yaml) and creates the `payflow-lab` web service.
2. When prompted, set **`DATABASE_URL`** = your Supabase URI from step 2.
   (Everything else — `PGSSL`, `AUTO_MIGRATE`, `ADMIN_API_KEY`, `CORS_ORIGIN` — is
   pre-filled by the blueprint; `ADMIN_API_KEY` is auto-generated.)
3. Click **Apply / Deploy**. First build takes a few minutes.

When it's live you get a URL like `https://payflow-lab.onrender.com`. Check:
- Dashboard → `https://payflow-lab.onrender.com/`
- Merchant store → `https://payflow-lab.onrender.com/merchant`
- Health → `https://payflow-lab.onrender.com/health`

Grab the generated **`ADMIN_API_KEY`** from the Render dashboard (Environment tab) —
you'll need it to run simulations/incidents against the live URL:
```bash
curl -X POST https://payflow-lab.onrender.com/api/v1/simulation/start \
  -H "Content-Type: application/json" -H "x-admin-key: <KEY>" \
  -d '{"transactions":300,"transactionsPerSecond":150}'
```
(The merchant `POST /payments` needs **no** key — that's the public storefront path.)

## 4. Pay from your phone
Open `https://payflow-lab.onrender.com/merchant` on your phone → tap **Pay now** →
watch it resolve, then see it appear on the dashboard's Transactions/Logs tabs.

> **Cold start:** on the free tier the service sleeps after ~15 min idle. The first
> request wakes it (~30–60s) — open `/health` or the dashboard first, then pay.
> Optional: a free UptimeRobot monitor hitting `/health` every ~10 min keeps it warm.

## 5. (Later) Wrap the merchant page as an Android APK
The `/merchant` page is built to be wrapped. When you're ready, we'll use
**Capacitor** (or Expo) pointing at your Render URL, and produce a sideloadable
`.apk`. The APK compile runs on your machine (Android SDK) or via Expo's cloud build.

## Environment variables (reference)
| Var | Purpose | On Render |
|-----|---------|-----------|
| `DATABASE_URL` | Supabase Postgres URI | **you set it** |
| `PGSSL` | SSL for managed Postgres | `true` |
| `AUTO_MIGRATE` | create schema on boot | `true` |
| `ADMIN_API_KEY` | protect admin/sim/incident endpoints | auto-generated |
| `CORS_ORIGIN` | allow the merchant app/APK | `*` (tighten later) |
| `BASE_URL` | webhook target | auto (`RENDER_EXTERNAL_URL`) |

## Free-tier caveats
- **Render free web** sleeps after ~15 min idle (cold start on next hit). If it
  sleeps while a payment is mid-flight, that one can stay `pending`.
- **Supabase free** pauses a project after ~7 days of inactivity (one click to restore).
- Neither affects an active session — wake it, then everything works end to end.

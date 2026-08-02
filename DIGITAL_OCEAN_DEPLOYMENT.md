# Digital Ocean Enterprise Launch Checklist

This guide provides a rigorous, step-by-step launch checklist for deploying the Student Post-Visa Tracker (SPVT) on Digital Ocean App Platform, adhering to enterprise-grade expert panel mandates.

## Phase 1: Managed Infrastructure (Stateful Layer)

1. **Database (PostgreSQL 16):** 
   - [ ] Go to Digital Ocean Dashboard -> **Databases** -> **Create Database Cluster**.
   - [ ] Select **PostgreSQL 16**.
   - [ ] Choose the region `blr1` (or match your V2 MIS database region).
   - [ ] **EXPERT MANDATE:** Ensure PITR (Point-in-Time Recovery) / Automated Backups are enabled for this cluster.
   - [ ] Click **Create Database Cluster**.
   - [ ] **EXPERT MANDATE:** Once created, navigate to **Users & Databases**, and create a new user called `spv_app`. Verify it does NOT have superuser privileges.

2. **Redis Cache (Optional for small teams):**
   - [ ] *Skipped:* For a 1-server deployment (2-5 users), the application gracefully falls back to local memory. You can skip Redis to save $15/mo.

3. **Digital Ocean Spaces (Object Storage / S3):**
   - [ ] Go to **Spaces** -> **Create a Space**.
   - [ ] Choose the same region (e.g., `blr1`).
   - [ ] Leave permissions as **Restrict File Listing**.
   - [ ] Pick a unique name (this is your `S3_BUCKET`).
   - [ ] Click **Create a Space**.
   - [ ] Go to **API** -> **Spaces Keys** -> **Generate New Key**. Save the Access Key and Secret Key securely.

4. **ClamAV (Optional for trusted small teams):**
   - [ ] *Skipped:* If your users are highly trusted and you want to save $12/mo, you can skip provisioning the ClamAV Droplet. The application will automatically bypass scanning if the configuration is omitted.

## Phase 2: App Platform Deployment (Stateless Layer)

The application includes an App Platform specification file (`.do/app.yaml`).

1. **Connect GitHub:**
   - [ ] Go to **Apps** -> **Create App**.
   - [ ] Select **GitHub** and connect your repository.
   - [ ] Add the Database created in Phase 1 as an "App-Level Component".

2. **Inject Secrets (Enterprise Mandate):**
   - [ ] **EXPERT MANDATE:** All variables marked as `SECRET` in `.do/app.yaml` *must* be entered as encrypted values in the Digital Ocean UI.

   **Core Cryptography:**
   - [ ] `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`: Your generated RSA key pair.
   - [ ] `JWT_KID`: E.g., `2026-06-01-key-1`.
   - [ ] `REFRESH_TOKEN_PEPPER`: Run `openssl rand -hex 32`.
   - [ ] `LOG_HMAC_KEY_BASE64`: Run `openssl rand -base64 32`.
   - [ ] `KMS_KEK_BASE64`: Run `openssl rand -base64 32`.

   **Database:**
   - [ ] `DATABASE_URL`: Connection string for the `spv_app` user (NOT doadmin).
   - [ ] `V2_MIS_DATABASE_URL` & `V2_MIS_DATABASE_CA`: Read-only connection to V2 DB and its CA cert.

   **S3 & External Services:**
   - [ ] `S3_ENDPOINT`: E.g., `https://blr1.digitaloceanspaces.com`
   - [ ] `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`: From Phase 1.
   - [ ] *Skipped:* `CLAMAV_HOST` (leave completely blank to opt-out).
   - [ ] **EXPERT MANDATE:** Set `RESEND_API_KEY` (email) and `SENTRY_DSN` (error tracking) to ensure no silent failures.

3. **Launch:**
   - [ ] Click **Deploy**.
   - [ ] Verify the `migrate` job runs successfully.
   - [ ] Verify both `backend` and `frontend` services are healthy.

## Phase 3: Verification & Sign-off

- [ ] Execute `GET /api/v1/health/livez`. Must return 200 OK.
- [ ] Log in as a seeded Admin user.
- [ ] Upload a test PDF document. Verify it is successfully stored in Spaces (and bypassed AV).
- [ ] Review the `Activity / Audit Log` in the UI to confirm the upload was audited properly.

---

### Estimated Cost of Operations (FinOps) - Lightweight Setup
* **Backend:** $12/mo
* **Frontend:** $12/mo
* **PostgreSQL:** $15/mo
* **Spaces (S3):** $5/mo
* **Total Estimate:** ~$44/mo (Lightweight Production)

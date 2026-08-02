# Absolute Beginner & Browser AI Agent Deployment Script

This document provides exact, click-by-click instructions for deploying the Student Post-Visa Tracker on Digital Ocean. These instructions are designed to be executed by a non-developer or an automated Browser AI Agent (like a web automation script).

> [!IMPORTANT]
> **Pre-requisites:** You must be logged into Digital Ocean (https://cloud.digitalocean.com/) and have your GitHub account linked.

---

## 🚀 Stage 1: Create the Database

**Goal:** Create a PostgreSQL 16 database to store application data.

1. Navigate to: `https://cloud.digitalocean.com/databases`
2. Click the green **Create Database Cluster** button.
3. Under **Choose a database engine**, select **PostgreSQL**.
4. Under **Version**, select **16**.
5. Under **Choose a datacenter region**, click **Bangalore** (or the region closest to you, e.g., `blr1`).
6. Under **Choose a cluster configuration**, select the **Basic** node plan. (Cost should say ~$15/mo).
7. Scroll down to **Choose a name**, and type `spvt-db` into the text box.
8. Click the green **Create Database Cluster** button at the very bottom.
9. *Wait ~5 minutes for the database to finish creating.*
10. Once created, click on `spvt-db` in the list to open its dashboard.
11. Click the **Users & Databases** tab.
12. Under **Users**, type `spv_app` in the "Add new user" field, and click **Save**.
13. Click the **Overview** tab.
14. Under **Connection Details**, change the "User" dropdown from `doadmin` to `spv_app`.
15. Click **Copy** next to the `Connection String` (it starts with `postgresql://`). **Save this somewhere secure; this is your `DATABASE_URL`.**

---

## 🚀 Stage 2: Create File Storage (Spaces)

**Goal:** Create an S3-compatible storage bucket for uploaded PDFs.

1. Navigate to: `https://cloud.digitalocean.com/spaces`
2. Click the green **Create a Space** button (or "Create Spaces Bucket").
3. Under **Choose a datacenter region**, select the SAME region you picked for the database (e.g., **Bangalore**).
4. Under **File Listing**, ensure **Restrict File Listing** is selected.
5. Under **Choose a unique Space name**, type something unique, like `spvt-files-2026`. (If taken, add random numbers). **Save this name; this is your `S3_BUCKET`.**
6. Click the green **Create a Space** button.
7. Note the URL under the name (e.g., `https://blr1.digitaloceanspaces.com`). **Save this; this is your `S3_ENDPOINT`.**
8. Now, click on **API** in the main left sidebar of Digital Ocean (or go to `https://cloud.digitalocean.com/account/api/tokens`).
9. Click the **Spaces Keys** tab.
10. Click the **Generate New Key** button.
11. Name it `spvt-app-key` and click the checkmark.
12. Two long strings will appear. 
    - **Save the Key** (e.g., `DO00...`). This is your `S3_ACCESS_KEY_ID`.
    - **Save the Secret**. This is your `S3_SECRET_ACCESS_KEY`.

---

## 🚀 Stage 3: Deploy the Application

**Goal:** Connect GitHub and deploy the code via App Platform.

1. Navigate to: `https://cloud.digitalocean.com/apps`
2. Click the green **Create App** button.
3. Select **GitHub** as the source.
4. Select the repository containing this source code.
5. Ensure the branch is `main` (or your primary branch), and `Autodeploy` is checked. Click **Next**.
6. Digital Ocean will automatically detect the configuration from the `.do/app.yaml` file.
7. Click the **Edit** button next to the **Global Environment Variables** section.

### 🔑 Injecting the Secrets
You will see a list of blank variables. Click the **Encrypt** checkbox for ALL of them. Fill them out as follows:

* `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`: Paste your RSA key pair here. (If you don't have one, ask your AI or use a generator tool).
* `JWT_KID`: Type `default-key-1`.
* `REFRESH_TOKEN_PEPPER`: Type 32 random characters (e.g. `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6`).
* `LOG_HMAC_KEY_BASE64`: Type 32 random characters.
* `KMS_KEK_BASE64`: Type 32 random characters.
* `DATABASE_URL`: Paste the `spv_app` connection string you saved in Stage 1.
* `V2_MIS_DATABASE_URL`: Skip this if you aren't integrating the old system yet.
* `V2_MIS_DATABASE_CA`: Skip this if you aren't integrating the old system yet.
* `S3_ENDPOINT`: Paste the Endpoint URL from Stage 2.
* `S3_BUCKET`: Paste the Space Name from Stage 2.
* `S3_ACCESS_KEY_ID`: Paste the Access Key from Stage 2.
* `S3_SECRET_ACCESS_KEY`: Paste the Secret Key from Stage 2.
* `CLAMAV_HOST` / `CLAMAV_PORT`: Leave completely blank (we are bypassing this for lightweight setups).
* `RESEND_API_KEY`: Leave blank (emails will just print to logs).

8. After pasting all variables, click **Save**, then click **Next**.
9. Click **Next** on the Info page.
10. Click **Next** on the Review page.
11. Click the **Create Resources** (or **Deploy**) button.

---

## 🚀 Stage 4: Watch & Verify

1. You will be taken to your App's dashboard.
2. A progress bar will show "Building" and then "Deploying". This takes about 5 to 10 minutes.
3. Once the progress bar turns green and says **Deployed successfully**, click the **Live App** link at the top of the page.
4. You should see the login screen for the Student Post-Visa Tracker.
5. To verify it works, log in, go to a student profile, and try to upload a PDF. If it uploads successfully, your Space storage is working perfectly!

# FIX — known errors and how to solve them

Troubleshooting guide for the form, the admin panel and the Apps Script backend. To understand how the pieces fit together, read the [README](README.md) first.

## Contents

- [How to diagnose](#how-to-diagnose)
- [Backend and Apps Script deployment](#backend-and-apps-script-deployment)
- [Form and file uploads](#form-and-file-uploads)
- [Admin panel](#admin-panel)
- [Google Sheets](#google-sheets)
- [Drive and notification emails](#drive-and-notification-emails)
- [Frontend and hosting (Vercel)](#frontend-and-hosting-vercel)
- [Git and the Windows terminal](#git-and-the-windows-terminal)
- [Checklist after any change](#checklist-after-any-change)

---

## How to diagnose

When something fails, the message the visitor sees is often generic. The real cause is in one of these four places, in this order:

1. **The message on screen.** Many errors are specific ("File type not allowed", "Wrong password"). Search for it in this document with Ctrl+F.
2. **Apps Script > Executions** (clock icon, on the left). Every request from the form is an execution of `doPost`. Important: **`doPost` shows as "Completed" even when it failed**, because the server catches the error and returns it to the browser. Click the execution and look in the log for a line of level **Error**: the real cause is there.
3. **The browser console** (F12 > Console and Network). It shows content policy blocks, network errors and the exact response of the server.
4. **A direct `curl` request**, to know whether the problem is in the backend or in the site:

```bash
# The backend answers (it must return ok:true)
curl -sL "https://script.google.com/macros/s/YOUR_ID/exec"

# The backend returns the questions of the form
curl -sL -H "Content-Type: text/plain" -d '{"action":"getConfig"}' "https://script.google.com/macros/s/YOUR_ID/exec"
```

How to read the first command:

| Response | Meaning |
|---|---|
| `{"ok":true,"data":{"service":"request-form"}}` | The backend is fine. The problem is elsewhere. |
| Google sign-in HTML (`accounts.google.com`) | The deployment is not public. See [the form does not load](#the-form-could-not-be-loaded-cannot-reach-the-server). |
| HTML saying "Script function not found: doGet" | The code is not deployed. See [script function not found](#script-function-not-found-doget--dopost). |
| A Google 404 error | The URL is wrong or the deployment was archived. |

---

## Backend and Apps Script deployment

### The form could not be loaded. Cannot reach the server.

**Symptom.** The form shows that message when it opens, even with a working internet connection.

**Common causes**

- The Apps Script deployment is not public. A request receives the Google sign-in page instead of JSON. This is the most common cause.
- `config.js` still has the text `PASTE_THE_WEB_APP_URL_HERE` or a URL with a typo.
- A browser extension (ad blocker, privacy tool) blocks `script.google.com`.
- In production, the content policy (`vercel.json`) blocks the connection. See [the page has no styles](#the-page-has-no-styles-photos-or-data-in-production).

**Solution**

1. Run the `curl` above.
2. If it returns the Google page: in Apps Script, **Deploy > Manage deployments**, pencil. Set **Execute as: Me** and **Who has access: Anyone**. In Version choose **New version** and press **Deploy**. The URL does not change.
3. If the account belongs to a Google Workspace domain and the option "Anyone" does not appear, the domain administrator has it blocked. It must be enabled in the admin console, or use a personal Gmail account.

### Script function not found: doGet / doPost

**Symptom.** The `curl` or the browser shows that sentence on a Google page (the text is translated into the language of the account).

**Cause.** The deployment does not have the code of `Code.gs`: it was never pasted, it was saved but no new version was deployed, or the URL belongs to another project.

**Solution**

1. Open the project, `Code.gs`, and check that it contains `function doGet()`. If not, paste the whole `apps-script/Code.gs` and save.
2. **Deploy > Manage deployments**, pencil, **New version**, **Deploy**.
3. Check that the URL of that deployment is the one in `config.js`.

> Saving the code does **not** publish it. The Web App serves the last deployed *version*.

### ReferenceError: window is not defined (in a `.gs` file)

**Symptom.** In Executions you see `ReferenceError: window is not defined`, with a file such as `app.js.gs`. All requests may fail.

**Cause.** A frontend file (`app.js`, `config.js`, `admin.js`) was pasted into Apps Script by mistake. Apps Script runs the code of **all** `.gs` files when it starts every request, and `window` does not exist there.

**Solution.** Delete that file from the Apps Script project. Only `Code.gs` and `appsscript.json` must remain. Create a New version of the deployment.

### The specified permissions are not sufficient to call Session.getEffectiveUser

**Symptom.** `setup()` or saving from the panel fails with `Exception: The specified permissions are not sufficient to call Session.getEffectiveUser. Required permissions: https://www.googleapis.com/auth/userinfo.email`.

**Cause.** The manifest is missing the `userinfo.email` permission.

**Solution**

1. In **Project settings**, enable "Show appsscript.json manifest file in editor".
2. `oauthScopes` must contain these five permissions:
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/script.external_request`
   - `https://www.googleapis.com/auth/script.send_mail`
   - `https://www.googleapis.com/auth/userinfo.email`
3. Save, run `setup` again and accept the new permissions.
4. Create a **New version** of the deployment.

### I changed Code.gs and the site behaves the same

**Cause.** Saving does not publish. Or the browser / server holds the previous configuration in cache.

**Solution**

1. **Deploy > Manage deployments > pencil > New version > Deploy**.
2. The question configuration is kept for 10 minutes in the server cache. Wait, or save any change in the panel, which renews it.
3. In the browser, reload ignoring the cache: **Ctrl+Shift+R**.

### The property X is missing. Run setup().

**Cause.** The script looks for a property (`SPREADSHEET_ID` or `ROOT_FOLDER_ID`) that does not exist in **Script properties**. It happens in a new project where `setup()` has not run, or if the properties were deleted.

**Solution.** Run `setup()`. If you want to use an existing sheet or folder, create the property with its ID first.

### The tab "Responses" does not exist. Run setup().

**Cause.** `SPREADSHEET_ID` points to a spreadsheet where the tab does not exist: it has another name, or it is another spreadsheet (for example, a test one).

**Solution**

1. Check that `SPREADSHEET_ID` is the ID of the right spreadsheet (the part of the URL between `/d/` and `/edit`).
2. Check that the tab is named **exactly** like `SHEET_NAME` in `Code.gs`, or change the constant.
3. Run `setup()` again: it creates the missing tabs without touching the data.

### The spreadsheet cannot be opened (access error)

**Symptom.** The log shows an error opening the document, or `You do not have permission to access the document`.

**Cause.** The account that runs the script does not have **editor** access to the spreadsheet in `SPREADSHEET_ID`. It is typical when migrating to another account.

**Solution.** From the account that owns the spreadsheet, share it as editor with the account of the script. Then run `setup()` again.

### Temporary server error. Please try again.

**Symptom.** The form fails when submitting with that text, sometimes after waiting a long time at 100 %.

**Cause.** It is the generic message when the server threw an error that is not a validation error. **The real cause is in the log of the execution** (see [How to diagnose](#how-to-diagnose)). The most common ones:

| Line in the log | What to do |
|---|---|
| `The property … is missing` | See [The property X is missing](#the-property-x-is-missing-run-setup) |
| `The tab … does not exist` | See [The tab does not exist](#the-tab-responses-does-not-exist-run-setup) |
| Error accessing the document | See [The spreadsheet cannot be opened](#the-spreadsheet-cannot-be-opened-access-error) |
| `Row N of "…" was empty after writing it` | See [The row was empty](#row-n-was-empty-after-writing-it) |
| `Could not obtain lock` | Another execution was writing. Try again in a minute. |
| `Drive responded …` | Drive error: quota, full storage or deleted file. See [Drive](#drive-and-notification-emails) |
| `Service invoked too many times` or an email quota error | A daily Google quota was reached. Wait 24 hours or reduce the volume. |

### Row N was empty after writing it

**Cause.** The sheet discarded the write without an error: a protected range, a strict validation or a filter prevents writing in that row.

**Solution.** Check **Data > Protected sheets and ranges** and the data validations of the responses tab. The script must be able to edit the whole row.

### The form says it was sent, but the row does not appear

**Possible causes**

1. **`SPREADSHEET_ID` points to another spreadsheet.** The notification email has an "Open responses sheet" button that points to the sheet the script uses. Open it and look there.
2. **Duplicate detected.** If the browser retried with the same request identifier, the server answers "received" without writing again. Reload the page to start a new request.
3. **The row was deleted or moved.** Check the version history of the sheet (**File > Version history**).
4. **It was written to another tab** because of a similar tab name. Check `SHEET_NAME`.

### Exception: You cannot set the number format of the cells of a text column

**Cause.** The tab is a Google Sheets *table* whose columns have their own type, and the code tried to give a number format to the new row. Sheets rejects it, sometimes with a delay.

**Solution.** The current code does **not** apply formats per row (it only writes values), so if the error comes back there is modified code calling `setNumberFormat` or `setNumberFormats` on the new row. Remove that call.

### Lock timeout / the panel or the form hang

**Cause.** Several executions fight for the script lock (it is used when creating folders, appending rows and saving the configuration). A stuck execution holds the lock for up to 30 seconds.

**Solution.** Wait a minute and try again. If it repeats, check Executions to see which one is stuck and what is blocking it.

---

## Form and file uploads

### Validation messages of the form

| Message | Cause and solution |
|---|---|
| `Missing: …` / `This field is required.` | A required field is empty. |
| `Select an option.` | A single choice or dropdown question has no selection. |
| `Specify the "Other" option.` | "Other" was ticked without writing which. |
| `Type your number with the country code (for example +15551234567) or the local number only.` | Invalid phone. Valid examples: `71234567`, `+59171234567`. |
| `Use letters only, no numbers.` | City or country with digits or symbols. |
| `The date cannot be earlier than today.` | The deadline is in the past. |
| `The estimated length must be a number or a range of pages, e.g. 50-140.` | Type `80` or `50-140`. |
| `Invalid option in …` | The page is using old questions. Reload with **Ctrl+Shift+R**. |
| `Request rejected.` | The honeypot field "Website" was filled. It can happen if the browser autofill fills it: turn autofill off or reload. |

### File type not allowed / File size not allowed / Too many files

**Cause.** The file does not meet the rules in `FILE_RULES`: allowed extension, maximum total size per field and maximum number of files.

**Solution.** Convert or compress the file. To change the limits, edit `FILE_RULES` in `Code.gs` and deploy a new version.

### The file "x" is not a valid PDF. Check that it is not damaged.

**Cause.** The server compares the first bytes of the file with the real signature of the format declared by the extension. It fails if the file is damaged, empty, or of another type with a changed extension (for example, an executable renamed to `.pdf`, or an image renamed to `.docx`).

**Solution.** Open the file in its original program and save or export it again. If the file is legitimate and keeps being rejected, its format may not be among the verified ones (PDF, JPG, PNG, WebP, HEIC, DOC, DOCX).

### The upload of "x" was interrupted. Please try again.

**Cause.** The Drive upload session expired or was lost (404 or 410), for example after leaving the form open for many hours.

**Solution.** Press **Retry**. If it does not work, reload the page and submit again.

### A file did not finish uploading / The session expired / The upload expired

**Symptom.** Any of these messages asks you to "submit the request again".

**Cause.** The server keeps every request and every upload in a 6-hour cache. If the visitor took longer, or the cache was emptied, the server no longer recognizes the request. The form resets its own state.

**Solution.** Submit again. The files already uploaded in that session are uploaded again.

### The ID details changed. Please submit the request again.

**Cause.** After a failed submission, the person changed the ID number or the country. The folder was already created for the previous data.

**Solution.** Submit again. The right folder is created.

### Drive did not accept the chunk / Drive responded 4xx or 5xx

**Cause.** A passing Drive error, or the account that owns the script ran out of space.

**Solution.** The form retries up to 4 times with growing waits. If it persists, check the storage of the account that owns the script (drive.google.com/settings/storage) and try again.

### The bar stays at 100 % for a long time

**Cause.** The form already uploaded everything and is waiting for the server to record the request. If another request holds the lock, it waits up to 30 seconds and retries.

**Solution.** Wait. If several minutes pass and it ends with an error, look at the execution log ([How to diagnose](#how-to-diagnose)) and do not press the button repeatedly.

### Uploading large files is slow

**Cause.** Every 8 MB chunk goes through Apps Script, which has a fixed latency of several seconds per request. Up to 3 files are uploaded at the same time.

**Solution.** It is the expected behavior: a 1 GB file takes several minutes. The visitor's connection also counts.

---

## Admin panel

### Wrong password / Too many failed attempts. Wait 15 minutes.

**Cause.** A wrong password, or 20 failed attempts in a row, which block the login for 15 minutes.

**Solution.** If you remember it, wait 15 minutes. If not, see [I forgot the password](#i-forgot-the-password).

### I forgot the password

**Solution.** In the Apps Script editor, choose the function `resetAdminPassword` in the function dropdown and press **Run**. The **Execution log** shows the line `New admin panel password: …`. Sign in with it and change it from the panel. If the log is not visible, open it in **Executions**.

> The initial password is printed only the first time `setup()` runs. If `setup()` runs again, it does not show it again.

### The panel password is missing. Run setup().

**Cause.** The project has no stored password because `setup()` never ran.

**Solution.** Run `setup()`, or `resetAdminPassword` if only the password is missing.

### Your session expired. Please sign in again.

**Cause.** Panel sessions last 2 hours.

**Solution.** Sign in again. Unsaved changes are lost: save before leaving the panel open for a long time.

### Not saved: …

| Message | Cause |
|---|---|
| `There is a question without text.` | A question has no wording. Write it or delete it. |
| `The question "…" needs at least one option.` | A dropdown, single choice or checkboxes question without options. |
| `Add at least one notification email.` | The email list is empty. |
| `Invalid email: …` | A badly written email. |
| `Maximum 10 notification emails.` / `Maximum 60 questions.` | System limits (`MAX_QUESTIONS` in `Code.gs`). |
| `Invalid question identifier.` / `Invalid question type.` | The configuration sent is not the one the panel generated. Reload the page and repeat. |

### The questions I edited do not change in the form

**Cause.** The configuration is kept for 10 minutes in the server cache and the browser may hold the previous page.

**Solution.** Save again in the panel (it renews the cache) and reload the form with **Ctrl+Shift+R**.

### A factory question went back to its original text or type

**Cause.** `CONFIG_VERSION` was bumped when the code was updated, and the migration (`migrateConfig_`) rewrites the text, type and options of the questions listed in `MIGRATED_IDS`. It keeps whether they are active or required, their section and their order.

**Solution.** Edit it again in the panel. To avoid it in the future, do not bump `CONFIG_VERSION` unless you change those questions in `Code.gs` on purpose.

### I cannot change the type of a question

**Cause.** Factory questions only change type within their family: short answer ↔ paragraph, and dropdown ↔ single choice ↔ checkboxes. Full name, ID number, ID country and ID photo are locked because they build the folder. Phone, city, pages, date and files have a fixed type because they validate a specific datum.

**Solution.** If you need another behavior, create a new question (it supports short answer, paragraph, number, date, dropdown, single choice and checkboxes) and disable the factory one.

### Site photos

| Symptom | Cause and solution |
|---|---|
| `Use a JPG, PNG or WebP image.` | The file is not one of those formats. Convert the image. |
| `The image must weigh less than 6 MB.` | The browser shrinks it to 1600 px, but the original must be readable. Try another photo or reduce it first. |
| `That image could not be opened.` | The browser does not understand the format (for example, HEIC). Convert it to JPG. |
| `Could not upload: …` (server error) | Usually the domain administrator of Google blocks sharing by link, the Drive is full or the session expired. Look at the execution log. |
| `That photo cannot be changed.` | The identifier is not in `SITE_SLOTS` of `Code.gs`. Add it and deploy a new version. |
| The photo changed in the panel but not on the site | The browser keeps the latest list of photos. Reload with **Ctrl+Shift+R**. Check that `index.html` and `Code.gs` use the same identifier. |
| `Could not read the list of photos of the home page.` | `admin.html` cannot find `index.html` in the same folder of the site. |
| The uploaded photo is not displayed | The CSP must allow `https://lh3.googleusercontent.com` in `img-src` (`vercel.json`). |

---

## Google Sheets

### Values appear in the wrong columns

**Cause.** The server writes every answer in the column indicated by its configuration. If you **move or insert columns by hand** in the sheet, new values keep going to the original position.

**Solution.** Do not move or insert columns of the responses tab. To arrange your view, use filters or filter views. New columns are added by themselves at the end when a question is created from the panel.

### The STATUS dropdown disappeared

**Cause.** The definition of the Sheets table was modified partially (for example, through the API) and the validation rule of the column was lost.

**Solution.** Select the `STATUS` column again and apply the data validation again (a dropdown with your statuses). Do not do it with a partial request to the tables API: it replaces all column properties.

### A header of the sheet changed by itself

**Cause.** When the panel is saved, the server updates the header of every question with its current text.

**Solution.** It is expected: the header follows the text of the question. If you want another header, change the text of the question in the panel.

### I deleted a question and its column is still in the sheet

**Cause.** By design: when a question is deleted, its column and its answers are kept so no data is lost.

**Solution.** If you want it gone, delete it yourself from the sheet. It does not affect operation.

---

## Drive and notification emails

### A new folder was created instead of reusing the person's folder

**Cause.** The key `user:<ID>-<COUNTRY>` of the script properties was lost (for example, after migrating accounts) or the previous folder is in the trash.

**Solution.** Without the property, the script first looks for a folder whose name starts with `ID-COUNTRY-`. If it does not find one, it creates a new one. To merge folders, move them by hand.

### Folders are created in the wrong Drive

**Cause.** The script is deployed with "Execute as: Me" from another account, or it was deployed from the account of whoever built the system instead of the client's.

**Solution.** The files use the storage of the account that owns the script. Deploy the project from the right account (see [Moving to another Google account](README.md#12-moving-to-another-google-account)).

### The notification emails do not arrive

**Causes**

- The email list in the panel is empty or badly written.
- The daily email quota of Apps Script was reached. Failed emails are skipped, but **the request is still recorded**.
- The email went to spam.

**Solution.** Check the list in the panel, look in the spam folder and in the execution log (search for `Could not send the notification`). If it is the quota, it resets in 24 hours; meanwhile requests keep entering the sheet.

### Whoever receives the notification cannot open the user's folder

**Cause.** Editor access to the main folder is granted when the panel is saved with that email in the list. Also, the email must belong to a Google account.

**Solution.** Remove and add the email again in the panel, and save. If the email is not a Google one, share the folder with them by link.

### I am worried that someone uploads an infected file

**What the system does.** It validates the extension, the size and the first chunk of the file (its real signature). Files are never executed or published. Drive scans them with its antivirus when they are downloaded.

**What is recommended to whoever opens them.** Download and open files with an up-to-date antivirus, and distrust Word documents that ask you to "enable macros". If you do not need `.doc` (the old format, which supports macros), remove it from `EXT_DOCS` in `Code.gs` and accept only `.docx`.

---

## Frontend and hosting (Vercel)

### The page has no styles, photos or data in production

**Symptom.** It works locally but in production fonts or photos are missing, or the questions do not load.

**Cause.** The content policy in `vercel.json` blocks something the site tries to load. By default it only allows: own scripts, own styles and Google Fonts styles, fonts from `fonts.gstatic.com`, own images, `data:`, `blob:` and `lh3.googleusercontent.com` images, and connections to `script.google.com` and `script.googleusercontent.com`.

**Solution**

1. Open the browser console (F12) and look for `Refused to load …` or `Content Security Policy` messages.
2. The message names the directive and the blocked domain. Add that domain to the matching directive in `vercel.json` (`img-src`, `connect-src`, `script-src`...).
3. Commit and push. Vercel deploys again by itself.

### Vercel asks me to sign in to see the site

**Cause.** Deployment Protection is on.

**Solution.** In the Vercel project: **Settings > Deployment Protection**, turn it off for production.

### Vercel cannot see my private repository

**Cause.** The Vercel GitHub application has no permission over that repository.

**Solution.** At <https://vercel.com/new>, press **Adjust GitHub App Permissions** and give it access to that repository.

### I changed something and the site is still the same

**Causes**

- Vercel is still deploying (it takes 1 or 2 minutes after the `push`).
- The browser has the previous version in cache.
- Photos in `assets/` are cached for 30 days (`Cache-Control` in `vercel.json`): if you replace a photo with the **same name**, the browser may keep showing the old one.

**Solution.** Wait for the deployment, reload with **Ctrl+Shift+R** and, for replaced photos, use a new file name.

### `/apps-script/Code.gs` or `/README.md` give 404 on the site

**Cause.** It is intentional: `.vercelignore` excludes those files from the public site.

### The form says "could not be loaded" and `config.js` still has the sample text

**Cause.** `SCRIPT_URL` still holds `PASTE_THE_WEB_APP_URL_HERE`.

**Solution.** Put the `/exec` URL of the Web App in `config.js`, commit and push.

---

## Git and the Windows terminal

| Problem | Solution |
|---|---|
| In PowerShell, `&&` gives an error (`The token '&&' is not a valid statement separator`) | Windows PowerShell 5.1 has no `&&`. Put each command on its own line, or separate them with `;`. |
| `gh` is not recognized right after installing it | Close the terminal and open a new one: the installation updates the PATH. |
| `git push` rejected (`non-fast-forward`) | There are remote commits you do not have. Run `git pull --rebase` and then `git push`. |
| `CRLF will be replaced by LF` warnings | They are harmless: Git normalizes the Windows line endings. |
| Heavy photos were committed by mistake and the repository grows | The photos in `assets/` are meant to be versioned. If you add many, reduce them first. Removing them from the history requires rewriting it. |

---

## Checklist after any change

Use it after deploying a new backend version or a new site version.

1. `curl -sL "<URL /exec>"` returns `{"ok":true,…}`.
2. `curl -sL -H "Content-Type: text/plain" -d '{"action":"getConfig"}' "<URL /exec>"` returns the expected questions.
3. The landing page loads with no broken photos, and the console (F12) shows no content policy errors.
4. The form opens, shows the three steps and the suggestion lists.
5. The panel `/admin.html` shows the login, and the password lets you in.
6. A test submission with a made-up ID number creates the folder in Drive, the row in the sheet and the notification email.
7. The test data is deleted (folder and row).

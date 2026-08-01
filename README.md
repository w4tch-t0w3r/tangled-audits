# tangled-audits

The public audit engine behind the free accessibility checker at
[tangled-design.ro/audit](https://tangled-design.ro/ro/audit).

**How it works:** the site dispatches an `audit-request` event with a
`{ id, url }` payload → the workflow loads the page in headless Chrome
and runs [axe-core](https://github.com/dequelabs/axe-core) with the WCAG
2.x A/AA rule tags (the rule set EN 301 549 and the Romanian
accessibility laws point to) → the JSON report is committed to
`reports/<id>.json`, where the site's report page reads it.

**Reports are public.** No accounts, no emails, no tracking — anyone
with the link can read a report. Don't submit URLs you consider private.

**What this cannot do:** automated testing covers only part of WCAG.
Screen-reader order, real keyboard operability, and the *quality* of
alt text can only be verified by people. Every report says so.

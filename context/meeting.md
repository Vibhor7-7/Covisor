# Checkout v1 planning sync
Date: 2026-11-19

- Agreed on Stripe Checkout over Paddle, ship v1 this week.
- Use hosted Stripe Checkout, not Elements, so card data never touches our servers.
- No new database tables: store the Stripe session id on the existing orders table.
- Open question: fix the open checkout bugs first, or ship around them.

<!--
Read by src/context.ts when MEETING_SOURCE is "file" (or "auto" without Granola).
Format: first "# " line is the title, the "Date:" line is the date (YYYY-MM-DD),
everything else becomes the summary paragraph. Put the key decision first:
the voice brief leads with it. HTML comments like this one are ignored.
-->

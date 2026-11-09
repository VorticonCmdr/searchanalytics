# Search Analytics alternative — privacy policy

**What the extension accesses.** After you sign in with Google (OAuth, read-only `webmasters.readonly` scope), the extension reads the Search Console properties you have access to and their search performance data. Your Google password is only ever entered on Google's own sign-in page; the extension never sees it.

**Where data goes.** Search Console data travels directly from Google's Search Console API to your browser. There is no server operated by the extension's author, no analytics and no tracking. Nothing you view is sent anywhere else.

**What is stored, and where.** Only in your own browser profile:

- the ID-extraction regex you set on the options page (Chrome sync storage, so it follows your Chrome profile across devices);
- the chart events you add or import (Chrome local storage).

Search Console data itself is not stored; it is fetched again each time you open a view. CSV files are only created when you click the download button.

**Google Search Status import.** When you click **Fetch events** on the options page, the extension downloads the public incident list from `https://status.search.google.com/incidents.json`. This request carries no personal data and no Search Console data.

**Signing out.** "sign out" clears the cached Google token. Removing the extension deletes all of the stored data listed above.

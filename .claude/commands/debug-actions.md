Look up recent messages from the contact "$ARGUMENTS" to help debug why an action item was or wasn't created.

Steps:
1. Search for the contact using the API: `curl -s 'http://localhost:11488/api/contacts/search?q=<name>'`
2. Using the top matching handleId, find their most recent messages: `curl -s 'http://localhost:11488/api/search?q=<terms>&from=<name>&limit=10&mode=text'` — try broad search terms related to recent activity, or use multiple searches.
3. For the most recent message found, get surrounding context: `curl -s 'http://localhost:11488/api/context?messageId=<id>&before=5&after=5'`
4. Check if any action items exist for this contact's chat: `curl -s 'http://localhost:11488/api/actions?completed=true'` and filter for the contact's name.
5. Check the chat metadata summary: `curl -s 'http://localhost:11488/api/chat-metadata'` and filter for the contact's name to see the latest summary and when metadata was last updated.

Then analyze:
- Was the conversation picked up during the last sync? (Compare message dates to `last_updated` in chat metadata)
- Does the most recent message meet action item criteria? (Someone asked a personal question, made a request, etc.)
- Could the LLM have reasonably decided no action was needed? (Casual/social message, rhetorical question, already answered)
- Was there a deduplication match with an existing action?

Report findings concisely: what the recent messages say, whether an action should exist, and the likely reason it was or wasn't created.

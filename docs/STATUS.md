# Status

What works, how it is checked, and what is still open. "Automated" means our test suite
(`npm test`); "Verified live" means exercised against a real model and/or the real Vory client.

| Capability (Definition of Done) | Automated | Verified live | Notes |
|---|---|---|---|
| 1. Gateway starts (Debian) | – | macOS only so far | Debian/systemd deployment pending a Linux host |
| 2. Stock Vory connects | protocol tests | Vory E2E + UI test pass (2026-10-14) | see `docs/COMPATIBILITY.md` |
| 3. Chat with a named agent on a configured model | yes (faux) | cerebras/gpt-oss-120b via Pi `auth.json` | |
| 4. Tool activity + genuine approvals | yes | tool events seen live in Vory | approval UI in Vory not yet driven by a live model |
| 5. Disconnect, restart, recover | yes (mid-answer + pending approval) | sessions/transcripts survive a live restart | |
| 6. Second agent with own identity/model/skills/memory | – | – | Phase 2/3 |
| 7. Remote VM administration | – | – | Phase 2; needs a VM |
| 8. Delegation between agents | – | – | Phase 2 |
| 9. SKILL.md skill | – | – | Phase 3 |
| 10. Memory across sessions, search, sharing | – | – | Phase 3 |
| 11. Recurring scheduled task, history | – | – | Phase 4 |
| 12. Pushover notification | – | – | Phase 4; needs Pushover keys |
| 13. Browser automation workflow | – | – | Phase 5 |
| 14. Remote desktop interaction | – | – | Phase 5; needs a Linux desktop |
| 15. Independent VM-resident agent | – | – | Phase 2 |
| 16. Backup and restore | – | – | Phase 6 |

---
"@de-otio/saas-foundation": patch
---

Correct the Prisma sub-path header comments: the `audit/prisma.ts` and
`feature-toggles/prisma.ts` stores reference `@prisma/client` only through their
structural client interfaces, not a top-level value-import (Prisma 7's bare
package exports nothing without a generated client). Comment-only change.

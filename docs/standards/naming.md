# Naming conventions

Status: Active — binding for new code.

Consistent naming is what lets someone guess a path instead of searching
for it. Inconsistency is a small cost paid constantly: three conventions
side by side in the same project mean every import starts with a "where is
this, actually" detour.

## File and folder naming

| Kind | Convention | Example |
| --- | --- | --- |
| Component folder | `PascalCase` | `OrderPanel/` |
| Component file | `PascalCase.tsx` | `OrderPanel.tsx` |
| Hook file | `camelCase.ts`, `use` prefix | `useOrderPanel.ts` |
| Context file | `PascalCase` + `Context` | `OrderPanelContext.tsx` |
| Utility file | `camelCase.ts` | `buildOrderQuery.ts` |
| Types / constants / barrel | lowercase | `types.ts`, `constants.ts`, `index.ts` |
| Style module | matches the component | `OrderPanel.module.scss` |
| Store | `camelCase.ts`, `use` prefix | `useOrderStore.ts` |
| Spec file | subject name + `.test.ts(x)` | `useOrderPanel.test.ts` |

**Folder name and main file name MUST match**: `OrderPanel/OrderPanel.tsx`,
never `OrderPanel/View.tsx`.

## Identifier naming

These are the conventions this rulebook binds. They are stated here on
their own authority — no wider organisational naming reference is claimed
for them:

- **Components**: `PascalCase` — `UserProfile`, `OrderList`.
- **Hooks**: `camelCase` with a `use` prefix — `useFetchData`, `useAuth`.
- **Props and local state**: `camelCase` — `isLoggedIn`, `userName`.
- **Functions and variables**: `camelCase` — `handleSubmit`, `fetchOrders`.
- **Constants**: `UPPER_SNAKE_CASE` for a genuinely constant, exported
  value — `API_ROUTES`, `DEFAULT_PAGE_SIZE`. A `let`-style local that
  merely never gets reassigned in one function is not what this covers;
  this is for values that are constants by design, not by accident.

## Existing code and renames

**Existing folders and files are renamed only as part of the work that
already touches them.** A rename-only change is a large, conflict-prone
diff on a fast-moving branch for a purely cosmetic gain; doing a sweep of
renames costs more than living with the inconsistency a while longer.
Rename when you are already restructuring the folder for another reason.

## Abbreviations

**Use an abbreviation the team already shares, and use it
consistently** — the same shortening in every file, not one spelling in one
file and a different one in the next.

**Do not invent a new abbreviation for something that does not already
have one.** A shortening only pays for itself once the whole team reads it
without pausing; before that point it is a private code every reader has
to decode. If a term is new, write it out in full and let an abbreviation
emerge only once it is used enough to deserve one.

## What is enforced

- `naming-standards` checks file and folder naming against the table
  above for new files.

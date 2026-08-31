# File size and decomposition

Status: Active — binding for new code.

## The thresholds

| Threshold | Level | What it means |
| --- | --- | --- |
| 1,000 lines | Warning | Decomposition is overdue. Raise it in review; splitting may become a separate follow-up task. |
| 1,500 lines | Critical | The build fails. Split the file, or add it to the project's documented exception list with a reason. |

**1,500 lines is a hard limit, enforced by the pipeline, with an explicit
escape hatch.** A limit that is only a suggestion gets ignored under
deadline pressure — exactly when it matters. A limit with no way out at all
turns the first legitimate exception into an argument for dropping the
rule entirely. The combination of "strict" and "has an exception process"
is what keeps it both followed and honest.

Thresholds MAY be refined per file kind by a project applying this
standard: a view component is unreadable long before a generated mapping
table or a declaration table is, so one number is generous to the first
and harsh to the second.

## Exceptions are per file, listed and justified

An exception is not granted ad hoc in a review comment. A file that
genuinely should not be split is added to a documented exception list with
a one-line reason, and that list is reviewed like any other change. The
cost of an exception is that somebody has to write down why — enough
friction to keep the list honest, little enough to keep the rule usable.

Legitimate categories for an exception:

- A generated file.
- An exhaustive mapping or configuration table, where splitting by line
  count alone would move the same declarations into more files without
  making any of them easier to understand.
- A third-party integration adapter whose shape is dictated externally,
  not by this project's own design choices.

## A line count is a symptom, not the disease

The real rule is the one in [`principles.md`](./principles.md): one file,
one job. A 1,400-line component that does four unrelated things is worse
than a 1,600-line table of static data. Use the number as a prompt to look
at the file, not as the verdict on its own.

Ask instead:

- Can you describe the file in one sentence without "and"?
- Does it hold more than one piece of state that nothing else in it reads?
- Does it render more than one visually independent region?
- Would a test for one part of it have to set up the other parts too?

Any "yes" means there is a split waiting, whatever the line count says.

## How to split, in order

Doing this in the wrong order — cutting JSX into fragments while the logic
underneath stays tangled — produces more files with exactly the same
coupling, which is worse than the one big file it replaced.

1. **Pull the logic out first.** Move state and rules into the component's
   own hook, and pure functions into a utility file. On the largest files
   this alone removes most of the volume and requires no change to what is
   actually rendered.
2. **Then extract child components**, along the seams the UI already
   has — a toolbar, a list, a detail panel, a set of dialogs.
3. **Then extract shared hooks**, where two of the new child components
   need the same behaviour.
4. **Only then consider splitting the view itself further**, if it is
   still large after the above.

## What is enforced

- `file-size-limit` fails the build at the critical threshold, and honours
  a project's documented exception list.

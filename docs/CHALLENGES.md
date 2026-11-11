# SlateMatch - Build Challenges and How Each Was Resolved
SlateMatch product pack, document 8 of 8. Previous: Go-To-Market Plan.
Written by C. Harsha Vardhana Reddy, in the first person.

I built SlateMatch as a working enterprise product, not a demonstration
skin: a real solver, a real audit trail, a real deployment. This
document records the hardest problems I met while building it, what I
changed because of each one, and what that change protects today. I
have kept it factual. Every fix described here is in the product now
and most carry a test with my name on the failure they prevent.

## 1. I had no budget, and the obvious hosts all wanted money or a card
The first deployment routes failed on a constraint that had nothing to
do with engineering: I would not pay a prepayment and would not put a
card down. Google Cloud asked for a billing prepayment before it would
run the service. The free tiers elsewhere were too small or too
temporary for an always-on product with a machine learning stack.
What I did: I evaluated the routes in writing against the constraint,
then deployed on AWS ECS using account credits, sized the service to
the smallest task that runs the product well, and capped autoscaling
at three tasks so a traffic spike can never turn into a bill. The
constraint improved the product: it is small, it is honest about its
costs, and it runs anywhere a container runs.

## 2. My solver once accepted an answer that was 37 cents short
At seven-figure amounts, the optimisation library's internal
tolerances let it return an invoice set that was a few cents short of
the payment and report it as exact. The total looked right. It was
not exact, and in accounting, not exact is wrong.
What I did: I stopped trusting the solver's own verdict. Every set it
returns is now re-verified in exact integer cents before anything is
believed, sets that fail are cut and retried a bounded number of
times, and a payment that cannot be solved exactly is returned as an
honest no-match with a note. A regression test reproduces the original
near miss and proves it can no longer pass.

## 3. The AI model that never answered
For days the AI parsing looked broken in a confusing way: the API key
was valid, some calls timed out, some returned quota errors, and
nothing explained the pattern. Three separate causes were stacked.
The free tier had a small daily quota for the model in use. The model
itself was a reasoning model that thinks for a long time before
answering, while the hosting platform ends any request at about sixty
seconds. And it emerged, from a screenshot of my own console, that the
model setting had never actually been applied to the deployment: the
application had been running on a built-in default the whole time.
What I did: I set the model explicitly in the deployment environment
to a low-latency model, capped the response length, set the product's
own AI timeout safely below the platform ceiling so a slow answer
degrades into the deterministic path instead of an error page, and
proved the result on the live service: a parse returned from the AI,
verified, in about three seconds. The runbook now records the lesson:
a setting that is not verified in the environment does not exist.

## 4. A free quota meant the AI could simply run out
The AI provider's free tier allows only a small number of requests a
day for a given model. A public demonstration link can spend that
before lunch.
What I did: I made the product deterministic first. Every AI feature
has a deterministic path behind it that produces a correct, labelled
answer, and the health endpoint shows the current AI mode and the
last AI error to anyone who looks. The AI is an enhancement with a
visible state, never a dependency with a hidden one. If the quota is
gone, the product keeps working and says why its answers changed
source.

## 5. The live product behaved differently from my local checks
Twice, my own verification misled me. Once, a run on the live service
processed zero payments because the check had silently landed in a
different workspace than the one the data was loaded into. Once, a
deployed fix looked absent because my browser was showing me a cached
page. Both times the evidence I collected was real; the frame around
it was wrong.
What I did: I changed how verification works. Checks now run through
the same path a user takes, carry one session identity through every
request, read the persisted state back after every action and assert
the counts. Asset URLs carry version stamps so a cache can never
disguise an old build as the current one. A success response is never
accepted as proof of anything by itself.

## 6. One missing tag hid five screens
A single unclosed section tag in the page markup nested five screens
inside a sixth, so they rendered inside a hidden parent and appeared
not to load. Every file check I had passed, because the content was
all present; it was simply inside the wrong parent.
What I did: I fixed the markup, then changed the checking method, not
just the file. A contract test now locks the page structure, and
screen checks assert that elements are actually visible on the page,
by their rendered geometry, never by the presence of their text in
the document. Text can exist in a hidden subtree. A rectangle cannot
lie.

## 7. Approving a refusal would have posted money with no invoice behind it
The approvals queue held one record that was not a match at all: the
engine's refusal verdict on a payment nothing in the ledger could
explain. The approval action was built for matches, and approving
this record would have issued a clearing document for money no
invoice supports, corrupting the very ledger the product exists to
keep clean.
What I did: I gave the refusal its own honest ending. Approving it
parks the amount in suspense, writes an audit entry that says what
happened, and issues no posting document. The queue also explains
itself: a refusal in the queue is labelled with its reason, so a
reviewer is never asked to approve something the screen has not
explained.

## 8. Two of my own screens disagreed with each other
In a strict audit I ran on the finished product, I approved a match,
watched the approvals queue correctly drop from five items to three,
and then asked the built-in assistant how many were waiting. It said
four, and named the match I had just approved. It was reading the
run's original snapshot instead of the live queue, so its answers
aged the moment anyone acted.
What I did: I made the assistant read the same live source the queue
itself is served from, so the two cannot drift again, and added a
test that decides a match and then requires the assistant's answer to
change. The wider rule is now a design rule for the whole product:
one fact, one source, every surface.

## 9. The demonstration data resets, and I chose to say so
The demonstration host has an ephemeral filesystem, so tenant data
resets when the service is redeployed. I could have hidden that
behind a marketing page. Instead the deployment documents state it
plainly, the demo case reloads in one action, and persistence is
named as the first task of a paid pilot, with the migration path
specified. A limitation that is written down is a roadmap item. A
limitation that is hidden is a lie waiting to be found.

## 10. Keeping every number honest was a discipline, not a feature
Three temptations recurred. Figures from my own specifications could
have been typed into the product as static values; they are examples,
so the rule became that every figure is computed from the run in
front of the user. A deduction win probability could have been
presented as a model's output; it is a heuristic, so it is labelled a
heuristic in the data, on the screen and in the mail the system
composes. And mail could have been reported as sent the moment a
button was pressed; until a mailbox exists, the product records it as
recorded, not sent, with the reason attached. None of this makes the
product look bigger. All of it makes the product safe to believe,
which for a finance system is the only size that matters.

## 11. A hostile audit of my own code found real faults, and I fixed them
Late in the build I put the codebase through an adversarial audit,
the kind a buyer's engineering team would run, and it found faults
that mattered. Re-running a batch could solve the same payments a
second time and double-post them, because the run paths handed the
engine the whole book instead of only the unreconciled payments, and
an auto-posted match never marked its invoices settled. An unknown
payer's wire could in principle clear two different customers'
invoices at once. An exact tie - two different invoice sets summing
to the same wire - posted automatically instead of going to a
person. The SAP payload carried a null customer on every line and no
document number on auto-posted matches. A diagnostics endpoint
returned the mail configuration including its password. A CSV
discount of 1 percent parsed as 100 percent.
What I did: I verified every claim against the code before touching
it (several were real, two were misdescribed, one was a design
decision I then changed on the evidence). Runs are now pending-only
at the engine, so no caller can double-post; auto-posts settle their
invoices; the single-customer and currency boundaries are hard;
ambiguous ties and weak-evidence matches are proposals with capped
confidence; approvals are claimed atomically so two approvers cannot
both win; SAP documents resolve the customer and carry deterministic
numbers; the password is redacted from every diagnostic surface; and
each fix has a regression test named after the defect. The Rust
kernel, which until then served as a verified accelerator on the
diagnostics page, now genuinely attempts the exact subset-sum first
on plain payments, deciding only the sets it can prove unique. The
suite stands at 124 tests after that round.

## 12. The second audit, and the fix that silently did nothing
The second report arrived the same evening as the first. Some of it
was right in ways that stung. My batch solved payments in the order
they sat in the file, so a wire carrying no evidence at all could
take an invoice that a later wire had been sent, by name, to pay.
Batches now run in evidence order: named references first, unknown
payers last, and the order used is recorded in the run's evidence.
Worse, approving a partial payment settled the whole invoice. A
twenty thousand dollar payment against a thirty-six thousand dollar
invoice, once approved, erased the remaining balance from the ledger
and from the forecast, as if the customer no longer owed it.
Approving a part payment now applies only what was paid, attributed
across the lines, and leaves the rest standing as a receivable. The
posting documents learned the same distinction: an unpaid remainder
is a residual receivable, an overpayment is the customer's
on-account credit, and neither is dumped into suspense.

The discount finding reached into my own demo data. Two of my seed
invoices were past their due dates while their wires took early
payment discounts, which means those discounts were unearned and my
own case data contradicted its remittance text. The engine now
claims an unearned discount back like any other short payment, as
its own reason code. I corrected the dates in the data rather than
weaken the rule, because the rule is the product and the data was
simply wrong.

Two of the report's claims did not survive contact with the code.
The latency story blamed a solver loop that does not exist in the
batch path (the why-not solver runs only when someone asks it a
question), and the frontend story named a function this codebase
does not contain, recommending a lazy-loading pattern the
navigation already uses. I checked both against the code before
changing anything, fixed the one real duplication the profile did
show (the same subset enumeration was being computed twice), and
left the rest alone. An audit is evidence, not instruction.

The sharpest lesson was my own. My first version of the partial
settlement fix read the residual from a field the stored match
record does not carry, so it quietly behaved exactly like the old
code while looking finished. Only the new regression test, written
for the defect, caught it. A fix that cannot fail its own test is
not a fix. The suite stands at 129 tests after that round.

## 13. The third audit: real defects under wrong descriptions
The third report listed five problems. Two of its claims did not
survive checking. The scenario packs were said to be out of sync
with the stricter solver rules; in fact all ten packs pass their
full check sets through the real run path, and the evaluations
endpoint, which grades the solver against labelled ground truth on
every call, reports a perfect score. It was also said that one
frontend file carried its own weaker escaping function; there is
only one escaping function in the frontend, shared by every page,
and it already escapes quotes.

Underneath those claims, though, sat real defects, and I fixed the
defects rather than the descriptions. Sixteen inline handlers across
three files were receiving strings built by interpolation. An
apostrophe in an ordinary customer name would have broken the
reminder button, and a crafted name could have escaped its string
entirely. Handlers now receive their values from data attributes,
never from built strings, and a test scans the frontend for the
pattern so it cannot quietly return. The forecast was predicting
every invoice on a constant thirty day term and a fixed October,
whatever the invoice or the calendar actually said. It now derives
each invoice's own terms from its issue and due dates, clamped to
the range the model was validated on, and uses the real month. And
the ledger, which since the last round could show a partially paid
invoice only as a smaller number, now shows the application itself
on the invoice's row: how much was applied, against what original
total, with the remaining balance as the amount owed.

The session restore findings in that report I left alone on
purpose. Session handling is a feature on my own roadmap, to be
built deliberately, not a defect to patch under audit pressure.
The suite stands at 134 tests.

## 14. The live audit found the third reader

Entry 12 recorded a fix that read a field the stored record does not
carry. It turns out the same phantom field had a third reader, in the
SAP document builder, and only a live audit caught it: after v40
deployed, approving the partial payment produced a clearing document
that did not balance (Dr cash 20,000 against Cr receivables 36,750,
no residual line), because the builder read the residual from the top
level of the match record instead of from its derivation equation.
Exact matches had concealed it completely: their residual is zero on
either reading, so ten of the eleven documents balanced and only the
partial one exposed it. The builder now reads the equation like the
other two readers, and the regression test approves a partial payment
and an overpayment and asserts both documents balance, line by line.
My earlier verification had checked the browser's preview builder,
which was correct, and called the document done. Verify through the
surface that ships.

The same audit reported five other failures, and every one of them
was a defect in the audit script itself: it read response keys the
API does not use (`documents` where the payload says `docs`, `steps`
where it says `agents`), while the product data underneath was
correct in each case. I fixed the script, not the product. Verify the
verifier, especially when it agrees with your fears.

## 15. The suite that passed slowly and failed fast

The v41 push came back red from CI on code that had passed every test
on my machine an hour earlier. Reproducing the CI run exactly (same
command, same working directory, no local environment) produced the
failure in nineteen seconds: a 429 from the product's own rate
limiter. Every unauthenticated test request shares one anonymous
bucket capped at 300 requests a minute, and the suite issues more
than that. Run slowly, the requests spread across several one-minute
windows and everything passes. Run at CI speed, they land inside a
single window and the last tests fail. The suite now sets its own
high ceiling in a conftest file, while the rate limiter's dedicated
test keeps its own limit of three and still proves the limiter bites.
A test suite is a system too, and its environment is part of its
truth: when CI and local disagree, reproduce CI exactly before
blaming the code. The corrected suite then went through the same CI
gate on the following pushes and came back green.

## 16. Pinning the ground the product stands on

Two quieter decisions belong in this log because they are the same
lesson in different clothes. The Python dependencies began unpinned:
a fresh install could pull a different version of a library than the
one the code had been tested against, and the failure would have
looked like a code bug. The requirements file now pins every
dependency to an exact version, locally and in the Docker build. And
the solver runs to an explicit contract - a 2.0 second time limit
and a 1e-6 relative gap tolerance - chosen constants, so its
behaviour does not drift with the machine it happens to run on.
Neither decision is visible in the product. Both are the product
standing on ground that does not move.

## Closing note

None of these problems were exotic. They are the ordinary failures of
real software: a tolerance, a cache, a missing tag, a setting that was
never applied, a budget that was not there. What I am proud of is not
that I avoided them. It is that each one left the product stricter
than it found it, and that the evidence for every claim in this pack
can be produced from the product itself, on request.

Version 3.1 | 3 Nov 2026 | Owner: C. Harsha Vardhana Reddy

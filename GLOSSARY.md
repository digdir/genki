# genki

genki is a shared platform for generative AI services in the Norwegian public sector. This glossary defines the words genki uses, so code, docs and the portal mean the same thing by them. It starts with evaluation; other areas are added as their words are settled.

## Evaluation

**Eval run**:
One pass of a test set version through one service variant, where every case is answered as for any other caller and then scored.
_Avoid_: test run, dataset run

**Experiment**:
Two or more eval runs on the same test set version that differ in exactly one thing, such as the variant, the model or the prompt, so their scores can be compared. Langfuse uses the word for a single run; in genki that is an eval run.
_Avoid_: dataset run, sweep

**Split**:
One of three groups a test case belongs to: train (looked at freely while improving a service), validation (used to check a change and by publishing gates) or holdout.
_Avoid_: partition, fold

**Holdout**:
The split of a test set kept away from anything that tunes a service, so a score on it is not inflated by tuning.
_Avoid_: locked split

**Judge**:
A model that grades an answer to a test case and gives a verdict with a reason.
_Avoid_: evaluator (for the model-based kind), grader

**Calibration label**:
A person's own verdict on a test case, to the same question a judge answered about it, used to measure how far that judge can be trusted.
_Avoid_: annotation, human score

**Feedback**:
What an end user says about a real answer in daily use, such as thumbs up or down with a comment.
_Avoid_: annotation, label, rating (for a reviewer's verdict)

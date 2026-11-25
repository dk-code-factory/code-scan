Find real defects in the chunk of code below. code-scan has already claimed this chunk for you and will
store your answer: you only read code and reply. Use as few turns as possible: put independent tool calls
in the same turn.

1. The text above gives the review profile (follow it), an optional focus, then either the code with line
   numbers or a list of files to read — read all listed files (in parallel if you can).
2. Confirm every candidate from the code: trace the path that triggers it, check for guards or caller
   contracts that rule it out; drop what you cannot confirm. Do not re-report anything listed as already
   dismissed unless the code changed so that its stated reason no longer applies. Look up other code with
   read-only commands (`grep -rn`, `head -n`/`tail -n` for line ranges), batched. Never build, run, test, edit or create
   files, and never run code-scan commands.
3. Your final reply is the submission: exactly the JSON object shown under REPLY, every file as a key
   ([] if clean). Finding fields: line, end_line, severity (critical|high|medium|low), type (one of the
   fixed types listed), category (your own short tag), title, detail (trigger path, impact), evidence
   (file:line facts), confidence 0..1. No prose around the JSON.

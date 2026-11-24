# Bench brief - leak-safe: tasks 1 to 10 of 105

<!-- leak-safe quarantine: 5 task(s) excluded from the pack before slicing; task numbering renumbered over the remaining 105 -->

This file holds the exact task text the launcher hands the agent. The launcher
reads the first fenced block under *Task text* and sha256s it, so nothing
outside that block reaches the agent and any edit inside it is a new task.
The block is the only fence in this file.

The workspace holds 105 independent bug-fix tasks under
`swe/<instance_id>/`; this launch lists tasks 1 to 10 of 105. Each task names its own
interpreter by absolute path inside the task list. On the other device the same
tree lives with `C:\Users\TZ\` in place of `C:\Users\TZhen\`.

## Task text

```text
You are a senior engineer working offline in this workspace. The workspace holds
105 independent bug-fix tasks, one per directory under swe/<instance_id>/.
Each directory is a full copy of an open-source Python project at the commit just
before one bug was fixed. Fix each bug at its source. Work through the tasks in
the order given below and keep going until all 105 are done.
This launch starts the work: tasks 1 to 10 of 105 are listed below.
PROTOCOL for every task below:
(1) Work strictly in the order given; do not skip ahead or jump back.
(2) One task at a time: read the issue in the task's repo, fix the code, then run that
    task's F2P tests with the venv python command given in the task block.
(3) Finish before moving on: a task is complete only when its report file
    swe-results/<instance_id>.md EXISTS. Write it immediately after you run the tests,
    before you touch the next task. The report states: what you changed (files and why),
    the exact test command you ran, and the F2P outcome (which tests passed or failed, and the counts).
(4) If you cannot make the F2P tests pass after a real attempt, STOP that task, write the
    report with status BLOCKED and the reason (what you tried, what still fails), and move
    to the next task. Never leave a task without its report.
(5) The final part of this session writes the summary report and ends with BENCH-DONE; this part is done only when the last task below has its report.
Task 1 of 105 - cyclotruc__gitingest-115

injest url field isn't case insensitive.
type Https://... with a uppercasee h on mobile and there was a repo not found error. 


Repo path: swe/cyclotruc__gitingest-115/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_parse_query.py::test_parse_query_mixed_case
P2P tests: 32 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/cyclotruc__gitingest-115/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: the package sits under swe/cyclotruc__gitingest-115/src/, so the PYTHONPATH value is src.
Bash (Git Bash) form:
    cd swe/cyclotruc__gitingest-115 && PYTHONPATH=src "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/cyclotruc__gitingest-115/venv/Scripts/python.exe" -m pytest tests/test_parse_query.py::test_parse_query_mixed_case -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/cyclotruc__gitingest-115; $env:PYTHONPATH='src'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/cyclotruc__gitingest-115/venv/Scripts/python.exe" -m pytest tests/test_parse_query.py::test_parse_query_mixed_case -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/cyclotruc__gitingest-115.md

----------------------------------------------------------------------

Task 2 of 105 - MoshiBin__ssdpy-17

M-SEARCH has unescaped "Man" field
According to the official docs, the "Man" field's value should be wrapped in quotes.

Wrong:
        ```python
data = (                      
    "M-SEARCH * HTTP/1.1\r\n" 
    "HOST:{}\r\n"             
    "MAN: ssdp:discover\r\n"
    "ST:{}\r\n"               
    "MX:{}\r\n"               
).format(host, st, mx)
        ```

Right:
        ```python
data = (                      
    "M-SEARCH * HTTP/1.1\r\n" 
    "HOST:{}\r\n"             
    'MAN: "ssdp:discover"\r\n'
    "ST:{}\r\n"               
    "MX:{}\r\n"               
).format(host, st, mx)        
        ```

Repo path: swe/MoshiBin__ssdpy-17/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_protocol.py::TestProtocol::test_msearch_payload
P2P tests: 5 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/MoshiBin__ssdpy-17/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/MoshiBin__ssdpy-17/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/MoshiBin__ssdpy-17 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/MoshiBin__ssdpy-17/venv/Scripts/python.exe" -m pytest tests/test_protocol.py::TestProtocol::test_msearch_payload -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/MoshiBin__ssdpy-17; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/MoshiBin__ssdpy-17/venv/Scripts/python.exe" -m pytest tests/test_protocol.py::TestProtocol::test_msearch_payload -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/MoshiBin__ssdpy-17.md

----------------------------------------------------------------------

Task 3 of 105 - j4c0bs__spectron-19

Pass case_insensitive arg to MaxDict
MaxDict needs an optional arg to ignore parent key case.

Repo path: swe/j4c0bs__spectron-19/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_MaxDict.py::test__max_dicts__case
P2P tests: 5 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/j4c0bs__spectron-19/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/j4c0bs__spectron-19/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/j4c0bs__spectron-19 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/j4c0bs__spectron-19/venv/Scripts/python.exe" -m pytest tests/test_MaxDict.py::test__max_dicts__case -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/j4c0bs__spectron-19; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/j4c0bs__spectron-19/venv/Scripts/python.exe" -m pytest tests/test_MaxDict.py::test__max_dicts__case -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/j4c0bs__spectron-19.md

----------------------------------------------------------------------

Task 4 of 105 - PyCQA__mccabe-47

Trivial function with docstring reports complexity of 2
        ```python
def f():
    """hi"""
    x = 1


def g():
    """hi"""
        ```

        ```
$ python3.5 mccabe.py test.py
1:0: 'f' 1
6:0: 'g' 2
        ```

        ```
$ git rev-parse HEAD
682145a37fee41fe7b6640244faa0c3f58e3b496
        ```

Repo path: swe/PyCQA__mccabe-47/

FAIL_TO_PASS test ids that must pass after your fix: test_mccabe.py::McCabeTestCase::test_expr_as_statement
P2P tests: 12 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/PyCQA__mccabe-47/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/PyCQA__mccabe-47/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/PyCQA__mccabe-47 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/PyCQA__mccabe-47/venv/Scripts/python.exe" -m pytest test_mccabe.py::McCabeTestCase::test_expr_as_statement -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/PyCQA__mccabe-47; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/PyCQA__mccabe-47/venv/Scripts/python.exe" -m pytest test_mccabe.py::McCabeTestCase::test_expr_as_statement -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/PyCQA__mccabe-47.md

----------------------------------------------------------------------

Task 5 of 105 - ilevkivskyi__com2ann-58

Multiple input files are generated to single file
When a command is called with multiple files (ex. `com2ann f1.py f2.py`), then the first file (`f1.py`) is chosen as output for both files.

This is especially problematic when `pre-commit` hook is used.

Repo path: swe/ilevkivskyi__com2ann-58/

FAIL_TO_PASS test ids that must pass after your fix: src/test_cli.py::test_process_multiple_input_files
P2P tests: 11 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/ilevkivskyi__com2ann-58/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: the package sits under swe/ilevkivskyi__com2ann-58/src/, so the PYTHONPATH value is src.
Bash (Git Bash) form:
    cd swe/ilevkivskyi__com2ann-58 && PYTHONPATH=src "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/ilevkivskyi__com2ann-58/venv/Scripts/python.exe" -m pytest src/test_cli.py::test_process_multiple_input_files -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/ilevkivskyi__com2ann-58; $env:PYTHONPATH='src'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/ilevkivskyi__com2ann-58/venv/Scripts/python.exe" -m pytest src/test_cli.py::test_process_multiple_input_files -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/ilevkivskyi__com2ann-58.md

----------------------------------------------------------------------

Task 6 of 105 - zalando-stups__zign-14

Transparently get service tokens via "tokens" library if possible
We already have the `zign.api.get_token` function and we should consider getting service tokens transparently also when using `zign token` directly.

Repo path: swe/zalando-stups__zign-14/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_api.py::test_get_named_token_services
P2P tests: 7 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/zalando-stups__zign-14/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/zalando-stups__zign-14/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/zalando-stups__zign-14 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/zalando-stups__zign-14/venv/Scripts/python.exe" -m pytest tests/test_api.py::test_get_named_token_services -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/zalando-stups__zign-14; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/zalando-stups__zign-14/venv/Scripts/python.exe" -m pytest tests/test_api.py::test_get_named_token_services -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/zalando-stups__zign-14.md

----------------------------------------------------------------------

Task 7 of 105 - fastmonkeys__stellar-76

ValueError: invalid literal for int() with base 10: '6beta1'
Related to following issue: #67 
I'm using Postgres 9.6beta1 on Linux.
The error happens when I try to take a snapshot.

Repo path: swe/fastmonkeys__stellar-76/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_operations.py::TestGetPidColumn::test_returns_pid_for_version_equal_or_newer_than_9_2[9.6beta1]
P2P tests: 10 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/fastmonkeys__stellar-76/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/fastmonkeys__stellar-76/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/fastmonkeys__stellar-76 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/fastmonkeys__stellar-76/venv/Scripts/python.exe" -m pytest tests/test_operations.py::TestGetPidColumn::test_returns_pid_for_version_equal_or_newer_than_9_2[9.6beta1] -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/fastmonkeys__stellar-76; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/fastmonkeys__stellar-76/venv/Scripts/python.exe" -m pytest tests/test_operations.py::TestGetPidColumn::test_returns_pid_for_version_equal_or_newer_than_9_2[9.6beta1] -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/fastmonkeys__stellar-76.md

----------------------------------------------------------------------

Task 8 of 105 - inducer__pycparserext-62

Support for case ranges
Hi,

Thanks for this project!

I see that you've implemented designated range initializers. Would you consider implementing the somewhat related case ranges (https://gcc.gnu.org/onlinedocs/gcc/Case-Ranges.html)?

Repo path: swe/inducer__pycparserext-62/

FAIL_TO_PASS test ids that must pass after your fix: test/test_pycparserext.py::test_case_ranges
P2P tests: 32 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/inducer__pycparserext-62/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/inducer__pycparserext-62/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/inducer__pycparserext-62 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/inducer__pycparserext-62/venv/Scripts/python.exe" -m pytest test/test_pycparserext.py::test_case_ranges -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/inducer__pycparserext-62; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/inducer__pycparserext-62/venv/Scripts/python.exe" -m pytest test/test_pycparserext.py::test_case_ranges -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/inducer__pycparserext-62.md

----------------------------------------------------------------------

Task 9 of 105 - happyleavesaoc__python-snapcast-55

[discussion] Group friendly name
At the moment the friendly name of a group is either the name (if manually set) or the stream name: `return self.name if self.name != '' else self.stream`
By default there are no names set and multiple groups could have the same stream, thus showing the same friendly name. In my opinion this makes sense only if someone is using exactly one group per stream and in that case one could set the group name manually.
So I would propose to change the fall-back to either the group id or a combination of client names.

Repo path: swe/happyleavesaoc__python-snapcast-55/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_group.py::TestSnapgroup::test_init
P2P tests: 12 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/happyleavesaoc__python-snapcast-55/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/happyleavesaoc__python-snapcast-55/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/happyleavesaoc__python-snapcast-55 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/happyleavesaoc__python-snapcast-55/venv/Scripts/python.exe" -m pytest tests/test_group.py::TestSnapgroup::test_init -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/happyleavesaoc__python-snapcast-55; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/happyleavesaoc__python-snapcast-55/venv/Scripts/python.exe" -m pytest tests/test_group.py::TestSnapgroup::test_init -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/happyleavesaoc__python-snapcast-55.md

----------------------------------------------------------------------

Task 10 of 105 - Turbo87__utm-62

__version__
\_\_version\_\_ is a convenient way to find a module's version.
        ```
>>> import numpy as np
>>> np.__version__
'1.15.1'

>>> import utm
>>> utm.__version__
Traceback (most recent call last):
  File "<stdin>", line 1, in <module>
AttributeError: module 'utm' has no attribute '__version__'
        ```
utm is lacking that attribute.

Repo path: swe/Turbo87__utm-62/

FAIL_TO_PASS test ids that must pass after your fix: test/test_utm.py::TestProject::test_version
P2P tests: 17 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/Turbo87__utm-62/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/Turbo87__utm-62/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/Turbo87__utm-62 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/Turbo87__utm-62/venv/Scripts/python.exe" -m pytest test/test_utm.py::TestProject::test_version -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/Turbo87__utm-62; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/Turbo87__utm-62/venv/Scripts/python.exe" -m pytest test/test_utm.py::TestProject::test_version -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/Turbo87__utm-62.md

----------------------------------------------------------------------
HARD RULES:
- No network access of any kind: no curl, no git clone, no git fetch, no git pull,
  no pip install, no downloads. Every package you need is already installed in the
  interpreter named above.
- Do not read or write anything outside this workspace.
- Do not create or modify test files. The tests are the grader; changing them
  changes nothing and is read as cheating.
- Do not edit files under swe-results/ except writing your own report files named below.
- Keep your changes inside the task's own directory. Do not patch a file outside
  swe/<instance_id>/ and do not touch another task's directory.
- If a task turns out to be impossible, say so in its report and move on. Never
  block the whole run on one task.

REPORTS. After finishing (or giving up on) each task, write
swe-results/<instance_id>.md with four sections: what the bug was; what you
changed (files and why); how you verified (the commands you ran and their
outcomes); your confidence.

A later part of this session names the remaining tasks; write every report at
swe-results/<instance_id>.md as you finish each one.

When every report file named below exists, print exactly one line as the
last line of your final message. Do not stop before it, and add nothing
after it.

The deliverables are, by exact path:
swe-results/cyclotruc__gitingest-115.md
swe-results/MoshiBin__ssdpy-17.md
swe-results/j4c0bs__spectron-19.md
swe-results/PyCQA__mccabe-47.md
swe-results/ilevkivskyi__com2ann-58.md
swe-results/zalando-stups__zign-14.md
swe-results/fastmonkeys__stellar-76.md
swe-results/inducer__pycparserext-62.md
swe-results/happyleavesaoc__python-snapcast-55.md
swe-results/Turbo87__utm-62.md
BENCH-DONE

```

## Brief notes

- Task text above is verbatim from the dataset rows: each problem statement
  was copied unchanged, and its triple-backtick lines were re-indented four
  spaces by the staging step, so the text carries no fence of its own.
- Source lineage, issueTextSourceSha256 per task:
  - cyclotruc__gitingest-115: 0742c091a42d32c8a0a650b8b34a157608aa4b669d81a573614f6ac77a93d334
  - MoshiBin__ssdpy-17: 7bf0495602d86a0803979b87fa2c2a2ca047ca62bf5f357c607155e27cc7890e
  - j4c0bs__spectron-19: e0f8beb007a1bddef41df475d9669eed51ef4495bb7bf7bf3bd9aa06c3618ae6
  - PyCQA__mccabe-47: 41bbe769352644f7d3de4927601f0e7687bd1fae191208d8e59c557876962554
  - ilevkivskyi__com2ann-58: 7151209e6f967db7462578152918d3bd2ad41fe826bc3ea1eff3bbf4fa386dd8
  - zalando-stups__zign-14: 3784da8c9374eaf6efd4d4580b4800c6020bba64a56ad488ee7d10269c8ad2f2
  - fastmonkeys__stellar-76: 3bc40ffde798a7a83dc8a9ef69f7d79f021e5dd26cc676b018c202e0df33ad32
  - inducer__pycparserext-62: 54b1187510f7dcce77c404120430fe81be3244fb79e7e108b2c04a7d1354cff7
  - happyleavesaoc__python-snapcast-55: b1c7b86ebf189c7a3b6ec7e80fe70f7ba515a08541922c3829287af6ac58225e
  - Turbo87__utm-62: df8ab0e5eee6dfca1d15e0727a82fb48e9356f034183717fe8fa7d0d11166cf0

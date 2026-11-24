Follow-up task - leak-safe segment 8 of 11
<!-- leak-safe quarantine: 5 task(s) excluded from the pack before slicing; task numbering renumbered over the remaining 105 -->

You are continuing the same engineering session. The tasks already listed are
done or reported; do not redo them. The workspace holds the
105 bug-fix directories under swe/<instance_id>/; this part lists
tasks 71 to 80 of 105. Fix each bug at its source. Work through
the tasks in the order given below and keep going until every task of the whole
105 is done. The same hard rules hold as at the start: no network access, no
test-file edits, changes inside the task's own directory only. Every task names
its own interpreter by absolute path; on the other device C:\Users\TZ\ replaces
C:\Users\TZhen\ in every path this file names.

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

Task 71 of 105 - sayanarijit__expandvars-41

Right Hand Side Variable Not Expanded with the '-' Operator
Take the example that I got from some random website

        ```
VAR1=1
VAR2=2
# var3 is unset.

echo ${VAR1-$VAR2}   # 1
echo ${VAR3-$VAR2}   # 2
        ```

This seems to be normal bash behaviour, but in the above example expandvars will output `1` and `$VAR2` respectively. Here is the Python code

        ```python

import os
from expandvars import expandvars

os.environ['VAR1'] = '1'
os.environ['VAR2'] = '2'

v = '${VAR1-$VAR2}'
print(f'{v} expands to "{expandvars(v)}"')    # ${VAR1-$VAR2} expands to "1"

v = '${VAR3-$VAR2}'
print(f'{v} expands to "{expandvars(v)}"')    # ${VAR3-$VAR2} expands to "$VAR2"
        ```

Repo path: swe/sayanarijit__expandvars-41/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_expandvars.py::test_expandvars_get_default
P2P tests: 23 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/sayanarijit__expandvars-41/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/sayanarijit__expandvars-41/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/sayanarijit__expandvars-41 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/sayanarijit__expandvars-41/venv/Scripts/python.exe" -m pytest tests/test_expandvars.py::test_expandvars_get_default -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/sayanarijit__expandvars-41; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/sayanarijit__expandvars-41/venv/Scripts/python.exe" -m pytest tests/test_expandvars.py::test_expandvars_get_default -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/sayanarijit__expandvars-41.md

----------------------------------------------------------------------

Task 72 of 105 - pytest-dev__apipkg-20

the `py.test workaround hides legitimate mistakes
c9b997713cb77d2c1334acb7847ee6b24e3261b2 introduced returning None on missing aliasmodules unconditionally
this does hide actual errors

Repo path: swe/pytest-dev__apipkg-20/

FAIL_TO_PASS test ids that must pass after your fix: test_apipkg.py::test_aliasmodule_aliases_unimportable_fails
P2P tests: 39 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/pytest-dev__apipkg-20/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: the package sits under swe/pytest-dev__apipkg-20/src/, so the PYTHONPATH value is src.
Bash (Git Bash) form:
    cd swe/pytest-dev__apipkg-20 && PYTHONPATH=src "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/pytest-dev__apipkg-20/venv/Scripts/python.exe" -m pytest test_apipkg.py::test_aliasmodule_aliases_unimportable_fails -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/pytest-dev__apipkg-20; $env:PYTHONPATH='src'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/pytest-dev__apipkg-20/venv/Scripts/python.exe" -m pytest test_apipkg.py::test_aliasmodule_aliases_unimportable_fails -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/pytest-dev__apipkg-20.md

----------------------------------------------------------------------

Task 73 of 105 - click-contrib__sphinx-click-94

Display `show_default` string even when `default=None`
# Current behavior

The option

        ```python
@click.option('--foo', show_default='mydefault')
        ```

will not have a default documented

# Expected behavior

The text `mydefault` is documented as the default value for this option.

# What now?

Looking at the code [here](https://github.com/click-contrib/sphinx-click/blob/6aeee375067483337b5cfda98233d4fb1a1addb1/sphinx_click/ext.py#L76), the fix seems relatively straightforward.

I'd like to submit a PR if you agree :)


Repo path: swe/click-contrib__sphinx-click-94/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_formatter.py::CommandTestCase::test_defaults
P2P tests: 15 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/click-contrib__sphinx-click-94/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/click-contrib__sphinx-click-94/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/click-contrib__sphinx-click-94 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/click-contrib__sphinx-click-94/venv/Scripts/python.exe" -m pytest tests/test_formatter.py::CommandTestCase::test_defaults -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/click-contrib__sphinx-click-94; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/click-contrib__sphinx-click-94/venv/Scripts/python.exe" -m pytest tests/test_formatter.py::CommandTestCase::test_defaults -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/click-contrib__sphinx-click-94.md

----------------------------------------------------------------------

Task 74 of 105 - rackerlabs__lambda-uploader-69

Easy sharing of code between lambda functions
Is there a way to share python code between lambdas, without having to create an additional package to install via requirements?

e.g., in the Serverless framework, there's the concept of a "lib" folder which can contain modules shared between multiple lambdas.



Repo path: swe/rackerlabs__lambda-uploader-69/

FAIL_TO_PASS test ids that must pass after your fix: test/test_package.py::test_package_with_extras
P2P tests: 8 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/rackerlabs__lambda-uploader-69/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/rackerlabs__lambda-uploader-69/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/rackerlabs__lambda-uploader-69 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/rackerlabs__lambda-uploader-69/venv/Scripts/python.exe" -m pytest test/test_package.py::test_package_with_extras -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/rackerlabs__lambda-uploader-69; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/rackerlabs__lambda-uploader-69/venv/Scripts/python.exe" -m pytest test/test_package.py::test_package_with_extras -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/rackerlabs__lambda-uploader-69.md

----------------------------------------------------------------------

Task 75 of 105 - OnroerendErfgoed__skosprovider_rdf-119

Don't export local id as dcterms.identifier when it's the URI
When reading a SKOS file, we assign the URI to the id attribute because our skosprovider expects an internal identifier. But, when exporting the provider to SKOS again, we export this id to dcterms:identifier. This creates extra information in the SKOS file that isn't completely. Solution: when exporting to SKOS, if id is equal to uri, don't generate dcterms:identifier statements.

Repo path: swe/OnroerendErfgoed__skosprovider_rdf-119/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_utils.py::TestRDFDumperProducts::test_dump_rdf_no_uri_as_local_identifier
P2P tests: 11 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/OnroerendErfgoed__skosprovider_rdf-119/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/OnroerendErfgoed__skosprovider_rdf-119/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/OnroerendErfgoed__skosprovider_rdf-119 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/OnroerendErfgoed__skosprovider_rdf-119/venv/Scripts/python.exe" -m pytest tests/test_utils.py::TestRDFDumperProducts::test_dump_rdf_no_uri_as_local_identifier -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/OnroerendErfgoed__skosprovider_rdf-119; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/OnroerendErfgoed__skosprovider_rdf-119/venv/Scripts/python.exe" -m pytest tests/test_utils.py::TestRDFDumperProducts::test_dump_rdf_no_uri_as_local_identifier -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/OnroerendErfgoed__skosprovider_rdf-119.md

----------------------------------------------------------------------

Task 76 of 105 - kangasta__fdbk-90

Data tools should support custom warnings
Forked from #45.

Add option to status data tool to show warning instead of updating status. This could be a separate `warning` function.

Repo path: swe/kangasta__fdbk-90/

FAIL_TO_PASS test ids that must pass after your fix: tst/test_data_tools.py::DataToolsTest::test_warning_functions
P2P tests: 13 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/kangasta__fdbk-90/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/kangasta__fdbk-90/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/kangasta__fdbk-90 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/kangasta__fdbk-90/venv/Scripts/python.exe" -m pytest tst/test_data_tools.py::DataToolsTest::test_warning_functions -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/kangasta__fdbk-90; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/kangasta__fdbk-90/venv/Scripts/python.exe" -m pytest tst/test_data_tools.py::DataToolsTest::test_warning_functions -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/kangasta__fdbk-90.md

----------------------------------------------------------------------

Task 77 of 105 - amjith__fuzzyfinder-19

case_insensitive as optional argument?
I have some old code that reads:
        ```python
from fuzzyfinder import fuzzyfinder
matches = fuzzyfinder(word_before_cursor, fuzzy_words, case_sensitive=True)
        ```
But I can't see in this project when case_sensitive was ever an option? Am I going crazy? Was case_sensitive the default and the extra parameter I was passing just doing nothing?



Repo path: swe/amjith__fuzzyfinder-19/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_fuzzyfinder.py::test_case_sensitive_substring_match
P2P tests: 10 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/amjith__fuzzyfinder-19/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/amjith__fuzzyfinder-19/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/amjith__fuzzyfinder-19 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/amjith__fuzzyfinder-19/venv/Scripts/python.exe" -m pytest tests/test_fuzzyfinder.py::test_case_sensitive_substring_match -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/amjith__fuzzyfinder-19; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/amjith__fuzzyfinder-19/venv/Scripts/python.exe" -m pytest tests/test_fuzzyfinder.py::test_case_sensitive_substring_match -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/amjith__fuzzyfinder-19.md

----------------------------------------------------------------------

Task 78 of 105 - scalableminds__cluster_tools-93

map_to_futures with empty list crashes, should return empty list
The resumable executor of voxelytics checks what needs to be re-run. If that list becomes empty, map_to_futures crashes

Repo path: swe/scalableminds__cluster_tools-93/

FAIL_TO_PASS test ids that must pass after your fix: test.py::test_empty_map_to_futures
P2P tests: 2 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/scalableminds__cluster_tools-93/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/scalableminds__cluster_tools-93/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/scalableminds__cluster_tools-93 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/scalableminds__cluster_tools-93/venv/Scripts/python.exe" -m pytest test.py::test_empty_map_to_futures -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/scalableminds__cluster_tools-93; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/scalableminds__cluster_tools-93/venv/Scripts/python.exe" -m pytest test.py::test_empty_map_to_futures -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/scalableminds__cluster_tools-93.md

----------------------------------------------------------------------

Task 79 of 105 - ifosch__accloudtant-52

Add price information to EC2 instances information


<!---
@huboard:{"order":6.0732421875,"milestone_order":0.09375,"custom_state":""}
-->


Repo path: swe/ifosch__accloudtant-52/

FAIL_TO_PASS test ids that must pass after your fix: tests/aws/test_reports.py::test_reports
P2P tests: 17 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/ifosch__accloudtant-52/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/ifosch__accloudtant-52/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/ifosch__accloudtant-52 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/ifosch__accloudtant-52/venv/Scripts/python.exe" -m pytest tests/aws/test_reports.py::test_reports -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/ifosch__accloudtant-52; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/ifosch__accloudtant-52/venv/Scripts/python.exe" -m pytest tests/aws/test_reports.py::test_reports -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/ifosch__accloudtant-52.md

----------------------------------------------------------------------

Task 80 of 105 - cisagov__check-cve-2019-19781-10

UnicodeDecodeError: 'utf-8' codec can't decode byte 0xf6 in position 1144: invalid start byte
# 🐛 Bug Report



        ```console
$ cve-2019-19781 citrix.beispiel.de
Traceback (most recent call last):
  File "/home/ehret/.local/bin/cve-2019-19781", line 11, in <module>
    load_entry_point('cve-2019-19781', 'console_scripts', 'cve-2019-19781')()
  File "/tmp/check-cve-2019-19781/src/check_cve/check.py", line 117, in main
    if is_vulnerable(host, retries, timeout):
  File "/tmp/check-cve-2019-19781/src/check_cve/check.py", line 64, in is_vulnerable
    decoded_data = response.data.decode()
UnicodeDecodeError: 'utf-8' codec can't decode byte 0xf6 in position 1144: invalid start byte
        ```


Repo path: swe/cisagov__check-cve-2019-19781-10/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_check_cve.py::test_non_utf8_response
P2P tests: 14 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/cisagov__check-cve-2019-19781-10/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: the package sits under swe/cisagov__check-cve-2019-19781-10/src/, so the PYTHONPATH value is src.
Bash (Git Bash) form:
    cd swe/cisagov__check-cve-2019-19781-10 && PYTHONPATH=src "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/cisagov__check-cve-2019-19781-10/venv/Scripts/python.exe" -m pytest tests/test_check_cve.py::test_non_utf8_response -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/cisagov__check-cve-2019-19781-10; $env:PYTHONPATH='src'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/cisagov__check-cve-2019-19781-10/venv/Scripts/python.exe" -m pytest tests/test_check_cve.py::test_non_utf8_response -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/cisagov__check-cve-2019-19781-10.md

----------------------------------------------------------------------

When the last report file named below exists, print exactly one line:

BENCH-DONE

as the last line of an assistant message that also states, in at most three
sentences, what you produced. After that line, stop: no further message, no
further edit, no further read.

The deliverables are, by exact path:
swe-results/sayanarijit__expandvars-41.md
swe-results/pytest-dev__apipkg-20.md
swe-results/click-contrib__sphinx-click-94.md
swe-results/rackerlabs__lambda-uploader-69.md
swe-results/OnroerendErfgoed__skosprovider_rdf-119.md
swe-results/kangasta__fdbk-90.md
swe-results/amjith__fuzzyfinder-19.md
swe-results/scalableminds__cluster_tools-93.md
swe-results/ifosch__accloudtant-52.md
swe-results/cisagov__check-cve-2019-19781-10.md

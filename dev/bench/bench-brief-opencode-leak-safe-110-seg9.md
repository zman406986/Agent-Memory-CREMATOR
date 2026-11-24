Follow-up task - leak-safe segment 9 of 11
<!-- leak-safe quarantine: 5 task(s) excluded from the pack before slicing; task numbering renumbered over the remaining 105 -->

You are continuing the same engineering session. The tasks already listed are
done or reported; do not redo them. The workspace holds the
105 bug-fix directories under swe/<instance_id>/; this part lists
tasks 81 to 90 of 105. Fix each bug at its source. Work through
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

Task 81 of 105 - keleshev__schema-85

doesn't work with operator.methodcaller
    from operator import methodcaller
    from schema import Schema

    f = methodcaller('endswith', '.csv')
    assert f('test.csv')

    Schema(f).validate('test.csv')

    AttributeError: 'operator.methodcaller' object has no attribute '__name__'

We can't assume that all callables have a `__name__`, it would seem.

Repo path: swe/keleshev__schema-85/

FAIL_TO_PASS test ids that must pass after your fix: test_schema.py::test_issue_56_cant_rely_on_callables_to_have_name
P2P tests: 26 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/keleshev__schema-85/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/keleshev__schema-85/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/keleshev__schema-85 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/keleshev__schema-85/venv/Scripts/python.exe" -m pytest test_schema.py::test_issue_56_cant_rely_on_callables_to_have_name -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/keleshev__schema-85; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/keleshev__schema-85/venv/Scripts/python.exe" -m pytest test_schema.py::test_issue_56_cant_rely_on_callables_to_have_name -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/keleshev__schema-85.md

----------------------------------------------------------------------

Task 82 of 105 - ESSS__conda-devenv-114

Incorrect rendering of pip dependencies with flags
Defining multiple dependencies in the `pip` section with flags such as  `--editable/-e`:

        ```
dependencies:
- pip:
  - --editable path/to/first/package
  - --editable path/to/second/package
name: pip_editable_test
        ```

generates this:

        ```
dependencies:
- pip:
  - --editable path/to/first/package,path/to/second/package
name: pip_editable_test
        ```

which causes `pip` to fail because of the comma. And even replacing the comma with a space produces an incorrect result because only the first dependency is installed as editable.

Repo path: swe/ESSS__conda-devenv-114/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_merge.py::test_merge_dependencies_version_specifications_pip_dependencies
P2P tests: 7 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/ESSS__conda-devenv-114/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/ESSS__conda-devenv-114/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/ESSS__conda-devenv-114 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/ESSS__conda-devenv-114/venv/Scripts/python.exe" -m pytest tests/test_merge.py::test_merge_dependencies_version_specifications_pip_dependencies -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/ESSS__conda-devenv-114; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/ESSS__conda-devenv-114/venv/Scripts/python.exe" -m pytest tests/test_merge.py::test_merge_dependencies_version_specifications_pip_dependencies -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/ESSS__conda-devenv-114.md

----------------------------------------------------------------------

Task 83 of 105 - konradhalas__dacite-216

Incorrect work when using field with default_factory
**Describe the bug**
`default_factory` is called only once if a field absent in the data

**To Reproduce**
        ```python
#!/usr/bin/env python

from dataclasses import field, dataclass

from dacite import from_dict


@dataclass
class A:
    name: str
    items: list[str] = field(default_factory=list)


if __name__ == '__main__':
    a1 = from_dict(A, {'name': 'a1'})
    a2 = from_dict(A, {'name': 'a2'})
    print('Test identity:', a1.items is a2.items)
        ```
**Output**
        ```
Test identity: True
        ```

**Expected behavior**
`items` shouldn't be identical.
`dacite v1.7.0` works as expected
        ```
Test identity: False
        ```

**Environment**
- Python version: 3.9.16
- `dacite` version: 1.8.0



Repo path: swe/konradhalas__dacite-216/

FAIL_TO_PASS test ids that must pass after your fix: tests/core/test_base.py::test_dataclass_default_factory_identity
P2P tests: 15 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/konradhalas__dacite-216/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/konradhalas__dacite-216/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/konradhalas__dacite-216 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/konradhalas__dacite-216/venv/Scripts/python.exe" -m pytest tests/core/test_base.py::test_dataclass_default_factory_identity -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/konradhalas__dacite-216; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/konradhalas__dacite-216/venv/Scripts/python.exe" -m pytest tests/core/test_base.py::test_dataclass_default_factory_identity -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/konradhalas__dacite-216.md

----------------------------------------------------------------------

Task 84 of 105 - fox-it__dissect.cstruct-88

Tabs in constant expression should be treated like spaces
For example:

        ```c
#define A<tab>(B + C)<tab>// comment
        ```

currently errors when parsing, even though tabs are legal whitespace separators.

Repo path: swe/fox-it__dissect.cstruct-88/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_expression.py::test_expression[\t7\t*\t8\t-56]
P2P tests: 38 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/fox-it__dissect.cstruct-88/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/fox-it__dissect.cstruct-88/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/fox-it__dissect.cstruct-88 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/fox-it__dissect.cstruct-88/venv/Scripts/python.exe" -m pytest tests/test_expression.py::test_expression[\t7\t*\t8\t-56] -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/fox-it__dissect.cstruct-88; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/fox-it__dissect.cstruct-88/venv/Scripts/python.exe" -m pytest tests/test_expression.py::test_expression[\t7\t*\t8\t-56] -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/fox-it__dissect.cstruct-88.md

----------------------------------------------------------------------

Task 85 of 105 - asottile__all-repos-322

Support creating draft PRs for AzDO
Hey, I successfully configured the tool to run with Azure DevOps, but I noticed that config included in the repo always causes creating standard PRs. In my organization, a standard PR automatically triggers CI, so it creates high queues for CI agents when a lot of PRs are created.

For me, the simplest solution was to create draft PRs instead. AzDO supports `isDraft` parameter in the API call ([docs](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/create?view=azure-devops-rest-6.0)), so I did a minimal change in #322, and it seems to be working fine after adding `"draft": true` in `"push_settings"` in all-repos JSON config.

I thought that it might be useful for somebody out there, hence this issue and PR. Shall we merge it?

Repo path: swe/asottile__all-repos-322/

FAIL_TO_PASS test ids that must pass after your fix: tests/push/azure_repos_pull_request_test.py::test_settings_repr
P2P tests: 1 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/asottile__all-repos-322/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/asottile__all-repos-322/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/asottile__all-repos-322 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/asottile__all-repos-322/venv/Scripts/python.exe" -m pytest tests/push/azure_repos_pull_request_test.py::test_settings_repr -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/asottile__all-repos-322; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/asottile__all-repos-322/venv/Scripts/python.exe" -m pytest tests/push/azure_repos_pull_request_test.py::test_settings_repr -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/asottile__all-repos-322.md

----------------------------------------------------------------------

Task 86 of 105 - globocom__m3u8-375

UnicodeDecodeError: 'utf-8' codec can't decode byte 0x8b in position 1: invalid start byte
I get this error when doing 
`m3u8.load("https://cdn-vod-1.nxplay.com.br/hls/movies/94934c51-70e8-4583-8fac-2e045529c6d6/media_0.mp4/index-v1-a1.m3u8")`

UnicodeDecodeError: 'utf-8' codec can't decode byte 0x8b in position 1: invalid start byte

Not quite sure why...
It seems to be the code in httpclient.py, but can't get my head around it.

Repo path: swe/globocom__m3u8-375/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_http_client.py::TestDefaultHTTPClient::test_download_gzipped_content
P2P tests: 2 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/globocom__m3u8-375/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/globocom__m3u8-375/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/globocom__m3u8-375 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/globocom__m3u8-375/venv/Scripts/python.exe" -m pytest tests/test_http_client.py::TestDefaultHTTPClient::test_download_gzipped_content -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/globocom__m3u8-375; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/globocom__m3u8-375/venv/Scripts/python.exe" -m pytest tests/test_http_client.py::TestDefaultHTTPClient::test_download_gzipped_content -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/globocom__m3u8-375.md

----------------------------------------------------------------------

Task 87 of 105 - modm-io__lbuild-11

No warning/error on non-existing modules
You can add arbitrary module lines like `<module>This does not exist and is bullshit</module>` and there will be no error or warning. This is very unpleasant if modules names in modm changed and you will get no feedback from lbuild that a requested module was not found.

Accidentally reported against wrong project dergraaf/library-builder#31

Repo path: swe/modm-io__lbuild-11/

FAIL_TO_PASS test ids that must pass after your fix: test/parser_test.py::ParserTest::test_raise_unknown_module
P2P tests: 17 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/modm-io__lbuild-11/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/modm-io__lbuild-11/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/modm-io__lbuild-11 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/modm-io__lbuild-11/venv/Scripts/python.exe" -m pytest test/parser_test.py::ParserTest::test_raise_unknown_module -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/modm-io__lbuild-11; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/modm-io__lbuild-11/venv/Scripts/python.exe" -m pytest test/parser_test.py::ParserTest::test_raise_unknown_module -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/modm-io__lbuild-11.md

----------------------------------------------------------------------

Task 88 of 105 - borgbackup__borgstore-26

sftp URL's username should be optional
As noticed by @bket there: https://github.com/borgbackup/borg/issues/8373



Repo path: swe/borgbackup__borgstore-26/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_store.py::test_sftp_url[sftp://hostname/some/path-None-hostname-22-/some/path]
P2P tests: 14 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/borgbackup__borgstore-26/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: the package sits under swe/borgbackup__borgstore-26/src/, so the PYTHONPATH value is src.
Bash (Git Bash) form:
    cd swe/borgbackup__borgstore-26 && PYTHONPATH=src "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/borgbackup__borgstore-26/venv/Scripts/python.exe" -m pytest tests/test_store.py::test_sftp_url[sftp://hostname/some/path-None-hostname-22-/some/path] -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/borgbackup__borgstore-26; $env:PYTHONPATH='src'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/borgbackup__borgstore-26/venv/Scripts/python.exe" -m pytest tests/test_store.py::test_sftp_url[sftp://hostname/some/path-None-hostname-22-/some/path] -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/borgbackup__borgstore-26.md

----------------------------------------------------------------------

Task 89 of 105 - PaulSchweizer__flowpipe-127

Add sub output plugs through Node decorator
This should be made possible:

        ```python
@Node(outputs=["out.a", "out.b"])
MyNode():
    pass
        ```

Resulting in a node like this:

        ```
+-----------+
|  MyNode   |
+-----------+
|       out %
|    out.a  o
|    out.b  o
+-----------+
        ```

Repo path: swe/PaulSchweizer__flowpipe-127/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_convert_function_to_node.py::test_create_node_with_sub_output_plugs
P2P tests: 15 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/PaulSchweizer__flowpipe-127/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/PaulSchweizer__flowpipe-127/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/PaulSchweizer__flowpipe-127 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/PaulSchweizer__flowpipe-127/venv/Scripts/python.exe" -m pytest tests/test_convert_function_to_node.py::test_create_node_with_sub_output_plugs -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/PaulSchweizer__flowpipe-127; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/PaulSchweizer__flowpipe-127/venv/Scripts/python.exe" -m pytest tests/test_convert_function_to_node.py::test_create_node_with_sub_output_plugs -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/PaulSchweizer__flowpipe-127.md

----------------------------------------------------------------------

Task 90 of 105 - tofunlp__lineflow-254

Should slice of IterableDataset return IterableDataset not List?
**Is your feature request related to a problem? Please describe.**

        ```py
train = lfds.SciTLDR(split="train")  # IterableDataset
train_mini = train[:10]  # Now this is just a python list (List[Any])
        ```

If I make a subset of a dataset, it loses all the features such as `.map`.

**Describe the solution you'd like**
Return `IterableDataset` in stead of List.

Repo path: swe/tofunlp__lineflow-254/

FAIL_TO_PASS test ids that must pass after your fix: tests/test_core.py::IterableDatasetTestCase::test_dunder_slice
P2P tests: 48 named in the pack (do not chase them; do not weaken them)

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/tofunlp__lineflow-254/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/tofunlp__lineflow-254/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot.
Bash (Git Bash) form:
    cd swe/tofunlp__lineflow-254 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/tofunlp__lineflow-254/venv/Scripts/python.exe" -m pytest tests/test_core.py::IterableDatasetTestCase::test_dunder_slice -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/tofunlp__lineflow-254; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/tofunlp__lineflow-254/venv/Scripts/python.exe" -m pytest tests/test_core.py::IterableDatasetTestCase::test_dunder_slice -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS ids; run them exactly as written.

Write the one report for this task, swe-results/tofunlp__lineflow-254.md

----------------------------------------------------------------------

When the last report file named below exists, print exactly one line:

BENCH-DONE

as the last line of an assistant message that also states, in at most three
sentences, what you produced. After that line, stop: no further message, no
further edit, no further read.

The deliverables are, by exact path:
swe-results/keleshev__schema-85.md
swe-results/ESSS__conda-devenv-114.md
swe-results/konradhalas__dacite-216.md
swe-results/fox-it__dissect.cstruct-88.md
swe-results/asottile__all-repos-322.md
swe-results/globocom__m3u8-375.md
swe-results/modm-io__lbuild-11.md
swe-results/borgbackup__borgstore-26.md
swe-results/PaulSchweizer__flowpipe-127.md
swe-results/tofunlp__lineflow-254.md

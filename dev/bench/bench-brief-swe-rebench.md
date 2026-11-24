# Bench brief - rebench: 4 offline bug-fix tasks

This file holds the exact task text the launcher hands the agent. The
launcher reads the first fenced block under *Task text* and sha256s it, so
nothing outside that block reaches the agent and any edit inside it is a new
task. The block is the only fence in this file.

The workspace holds 4 independent bug-fix tasks under
`swe/<instance_id>/`. Each is an open-source Python project at the commit
before one bug was fixed. Every task has its own virtualenv under
`C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/<instance_id>/venv/`
(other device: the same path with `C:\Users\TZ\` in place of
`C:\Users\TZhen\`) and its own PYTHONPATH form, stated per task below.

## Task text

```text
You are a senior engineer working offline in this workspace. The workspace holds
4 independent bug-fix tasks, one per directory under swe/<instance_id>/.
Each directory is a full copy of an open-source Python project at the commit just
before one bug was fixed. Fix each bug at its source. Work through the tasks in
the order given below and keep going until all 4 are done.

Task 1 of 4 - CrossGL__crosstl-257

Issue (verbatim from the dataset row):

ToDO for  translator frontend 
- this task is to add support for `translator` frontend add token in `lexer` so it can also identify these tokens. for this task the one file  `crosstl/src/translator/lexer.py`

List of task 

- [x] #42 
- [x] #43 
- [x] #44 
- [x] #45 
- [x] #46 
- [x] #47 
- [x] #48 
- [x] #49 
- [x] #50 
- [x] #51 
- [x] #52 
- [x] #53 
- [x] #54 
- [x] #55 
- [x] #56 
- [x] #57 
- [x] #58 
- [x] #59 
- [x] #60 

## how to assign task

- you can assign the task to  your self just comment down the name of task on the issue  which you want to work  we will be assign that task to you. 

- we are not limited to these task only feel free to create any issue weather it is `adding new feature` , `bug` some or some `fix` and start working on that .

for and query feel free to ask  on our [discord](https://discord.com/invite/uyRQKXhcyW) server we will be happy to help you out 😄 

Happy coding 🚀 

Thanks for contributing here 
sam


<!-- BOT_STATE: {"assignee": "samthakur587", "assigned_at": "2024-12-26T13:58:38.905601+00:00", "reminder_sent": false, "unassigned": false} -->

Repo path: swe/CrossGL__crosstl-257/ (the project for this task; its own tests live inside it).

Your fix will be graded by the harness after the run by applying the project's own tests; the FAIL_TO_PASS test ids that must pass afterwards are: tests/test_translator/test_lexer.py::test_data_types_tokenization; PASS_TO_PASS ids (14 total) will also be checked.

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/CrossGL__crosstl-257/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/CrossGL__crosstl-257/ is flat (the package sits directly in it), so the PYTHONPATH form is swe/CrossGL__crosstl-257.
Because pytest runs with swe/CrossGL__crosstl-257/ as cwd, the PYTHONPATH value below is ., which is
the same directory as the workspace-relative form above. If you instead run from the
workspace root, use the workspace-relative form swe/CrossGL__crosstl-257.
Bash (Git Bash) form:
    cd swe/CrossGL__crosstl-257 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/CrossGL__crosstl-257/venv/Scripts/python.exe" -m pytest tests/test_translator/test_lexer.py -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/CrossGL__crosstl-257; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/CrossGL__crosstl-257/venv/Scripts/python.exe" -m pytest tests/test_translator/test_lexer.py -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS test file(s). To run the PASS_TO_PASS ids as well,
point pytest at the test files those ids name, in the same way.

Write the one report for this task, swe-results/CrossGL__crosstl-257.md, after you finish it or give up on it.

----------------------------------------------------------------------

Task 2 of 4 - duo-labs__py_webauthn-241

Issue (verbatim from the dataset row):

Tweak SafetyNet check
SafetyNet-based attestation is on its way out for Android Keystore attestation via Play Integrity (if I'm understanding https://developer.android.com/privacy-and-security/safetynet/deprecation-timeline and https://android-developers.googleblog.com/2024/09/attestation-format-change-for-android-fido2-api.html correctly.) In this transition state it's possible for a device returning `"android-safetynet"` attestation to return responses with `"basicIntegrity": True` but `"ctsProfileMatch": False`.

Documentation on SafetyNet attestation verification is insufficient in the spec as the link it points to goes to that SafetyNet deprecation timeline. One proposed solution to make py_webauthn more flexible for use with passkeys is to change the requirement that `ctsProfileMatch` be true...

https://github.com/duo-labs/py_webauthn/blob/42537f58bb2dc073c03e7fd0f9dbf10d8c3b2c77/webauthn/registration/formats/android_safetynet.py#L142-L143

...to only require that `basicIntegrity` to be true. Adding a flag for this is probably a good idea, similar to what happened over here:

https://github.com/lbuchs/WebAuthn/commit/deb37c7314b5cf16cd4c36707339495f326be63c

Repo path: swe/duo-labs__py_webauthn-241/ (the project for this task; its own tests live inside it).

Your fix will be graded by the harness after the run by applying the project's own tests; the FAIL_TO_PASS test ids that must pass afterwards are: tests/test_verify_registration_response_android_safetynet.py::TestVerifyRegistrationResponseAndroidSafetyNet::test_verify_attestation_android_safetynet_basic_integrity_true_cts_profile_match_false; PASS_TO_PASS ids (10 total) will also be checked.
Those PASS_TO_PASS ids are:
    tests/test_verify_authentication_response.py::TestVerifyAuthenticationResponse::test_raises_exception_on_incorrect_public_key
    tests/test_verify_authentication_response.py::TestVerifyAuthenticationResponse::test_raises_exception_on_uv_required_but_false
    tests/test_verify_authentication_response.py::TestVerifyAuthenticationResponse::test_supports_already_parsed_credential
    tests/test_verify_authentication_response.py::TestVerifyAuthenticationResponse::test_supports_dict_credential
    tests/test_verify_authentication_response.py::TestVerifyAuthenticationResponse::test_supports_multiple_expected_origins
    tests/test_verify_authentication_response.py::TestVerifyAuthenticationResponse::test_verify_authentication_response_with_EC2_public_key
    tests/test_verify_authentication_response.py::TestVerifyAuthenticationResponse::test_verify_authentication_response_with_OKP_public_key
    tests/test_verify_authentication_response.py::TestVerifyAuthenticationResponse::test_verify_authentication_response_with_RSA_public_key
    tests/test_verify_registration_response_android_safetynet.py::TestVerifyRegistrationResponseAndroidSafetyNet::test_raise_attestation_android_safetynet_basic_integrity_false_cts_profile_match_false
    tests/test_verify_registration_response_android_safetynet.py::TestVerifyRegistrationResponseAndroidSafetyNet::test_verify_attestation_android_safetynet

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/duo-labs__py_webauthn-241/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/duo-labs__py_webauthn-241/ is flat (the package sits directly in it), so the PYTHONPATH form is swe/duo-labs__py_webauthn-241.
Because pytest runs with swe/duo-labs__py_webauthn-241/ as cwd, the PYTHONPATH value below is ., which is
the same directory as the workspace-relative form above. If you instead run from the
workspace root, use the workspace-relative form swe/duo-labs__py_webauthn-241.
Bash (Git Bash) form:
    cd swe/duo-labs__py_webauthn-241 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/duo-labs__py_webauthn-241/venv/Scripts/python.exe" -m pytest tests/test_verify_registration_response_android_safetynet.py -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/duo-labs__py_webauthn-241; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/duo-labs__py_webauthn-241/venv/Scripts/python.exe" -m pytest tests/test_verify_registration_response_android_safetynet.py -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS test file(s). To run the PASS_TO_PASS ids as well,
point pytest at the test files those ids name, in the same way.

Write the one report for this task, swe-results/duo-labs__py_webauthn-241.md, after you finish it or give up on it.

----------------------------------------------------------------------

Task 3 of 4 - iluvcapra__pycmx-12

Issue (verbatim from the dataset row):

Questions about event.number
I use print(len(events) when using CMX) with a maximum of 999 events, but my edl has more than 4000, the edl encoding is' ISO-8859-1 ', and the EDL.format is 3600. I would like to ask if there is a maximum limit for events.

Repo path: swe/iluvcapra__pycmx-12/ (the project for this task; its own tests live inside it).

Your fix will be graded by the harness after the run by applying the project's own tests; the FAIL_TO_PASS test ids that must pass afterwards are: tests/test_parse.py::TestParse::test_adobe_wide; PASS_TO_PASS ids (8 total) will also be checked.
Those PASS_TO_PASS ids are:
    tests/test_parse.py::TestParse::test_channel_map
    tests/test_parse.py::TestParse::test_event_counts
    tests/test_parse.py::TestParse::test_event_sanity
    tests/test_parse.py::TestParse::test_events
    tests/test_parse.py::TestParse::test_line_numbers
    tests/test_parse.py::TestParse::test_list_sanity
    tests/test_parse.py::TestParse::test_multi_edit_events
    tests/test_parse.py::TestParse::test_transition_name

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/iluvcapra__pycmx-12/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/iluvcapra__pycmx-12/ is flat (the package sits directly in it), so the PYTHONPATH form is swe/iluvcapra__pycmx-12.
Because pytest runs with swe/iluvcapra__pycmx-12/ as cwd, the PYTHONPATH value below is ., which is
the same directory as the workspace-relative form above. If you instead run from the
workspace root, use the workspace-relative form swe/iluvcapra__pycmx-12.
Bash (Git Bash) form:
    cd swe/iluvcapra__pycmx-12 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/iluvcapra__pycmx-12/venv/Scripts/python.exe" -m pytest tests/test_parse.py -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/iluvcapra__pycmx-12; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/iluvcapra__pycmx-12/venv/Scripts/python.exe" -m pytest tests/test_parse.py -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS test file(s). To run the PASS_TO_PASS ids as well,
point pytest at the test files those ids name, in the same way.

Write the one report for this task, swe-results/iluvcapra__pycmx-12.md, after you finish it or give up on it.

----------------------------------------------------------------------

Task 4 of 4 - asottile__dead-204

Issue (verbatim from the dataset row):

does not understand methods of returned classes
a bit trickier since the scope target isn't quite right here?

    def f():
        class C:
            def handle(self): ...
        return C

    f().handle()

    $ dead
    handle is never read, defined in t.py:3

Repo path: swe/asottile__dead-204/ (the project for this task; its own tests live inside it).

Your fix will be graded by the harness after the run by applying the project's own tests; the FAIL_TO_PASS test ids that must pass afterwards are: tests/dead_test.py::test_class_methods_in_closure; PASS_TO_PASS ids (31 total) will also be checked.

How to run Python for this task.
Interpreter, exactly this absolute path:
    C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/asottile__dead-204/venv/Scripts/python.exe
Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: swe/asottile__dead-204/ is flat (the package sits directly in it), so the PYTHONPATH form is swe/asottile__dead-204.
Because pytest runs with swe/asottile__dead-204/ as cwd, the PYTHONPATH value below is ., which is
the same directory as the workspace-relative form above. If you instead run from the
workspace root, use the workspace-relative form swe/asottile__dead-204.
Bash (Git Bash) form:
    cd swe/asottile__dead-204 && PYTHONPATH=. "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/asottile__dead-204/venv/Scripts/python.exe" -m pytest tests/dead_test.py -q --no-header -p no:cacheprovider
PowerShell form:
    Set-Location swe/asottile__dead-204; $env:PYTHONPATH='.'; & "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/asottile__dead-204/venv/Scripts/python.exe" -m pytest tests/dead_test.py -q --no-header -p no:cacheprovider
Targets above are the FAIL_TO_PASS test file(s). To run the PASS_TO_PASS ids as well,
point pytest at the test files those ids name, in the same way.

Write the one report for this task, swe-results/asottile__dead-204.md, after you finish it or give up on it.

----------------------------------------------------------------------

HARD RULES:
- No network access of any kind: no curl, no git clone, no git fetch, no git pull,
  no pip install, no downloads. Every package you need is already installed in the
  interpreter named above.
- Do not read or write anything outside this workspace.
- Do not create or modify test files. The tests are the grader; changing them
  changes nothing and is read as cheating.
- Do not edit files under swe-results/ except writing your own report files named below.
- Keep your changes inside the task's own directory. Do not patch a shared file
  outside swe/<instance_id>/ and do not touch another task's directory.
- If a task turns out to be impossible, say so in its report and move on. Never
  block the whole run on one task.

REPORTS. After finishing (or giving up on) each task, write
swe-results/<instance_id>.md with four sections: what the bug was; what you
changed (files and why); how you verified (the commands you ran and their
outcomes); your confidence. After the LAST task, write swe-results/summary.md
listing all 4 tasks with one line of outcome each.

When every report file named below exists, print exactly one line as the
last line of your final message. Do not stop before it, and add nothing
after it.

The deliverables are, by exact path:
swe-results/CrossGL__crosstl-257.md
swe-results/duo-labs__py_webauthn-241.md
swe-results/iluvcapra__pycmx-12.md
swe-results/asottile__dead-204.md
swe-results/summary.md
BENCH-DONE
```

## Brief notes

- Bench: rebench. Authored 2026-11-16.
- Task text above is verbatim from the dataset rows: the problem statement of
  each row was copied unchanged, and its triple-backtick fences were already
  rewritten as 4-space indentation by the staging step, so the text carries no
  fence of its own and the block stays a single fence.
- Source lineage, issueTextSourceSha256 per task:
  - CrossGL__crosstl-257: a786799051ed61c2dfd6650ec8c991ba9fd68bb97f98911f40be33bf214bc6be
  - duo-labs__py_webauthn-241: b675c3f4cb38645d1281d99c3f5a4023a333c7594a7dcb69781f8f4b8ebae6b3
  - iluvcapra__pycmx-12: 1b907d52f49768fc3748bfc216f43cecb827e0d7f5b99d50f8ee5e8df12caee4
  - asottile__dead-204: d889fc3ae8692c03f4f27de1aff220d7ae0df19076e94a1c3cdfc2c11d0076fb

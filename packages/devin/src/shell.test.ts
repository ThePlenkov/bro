/** The shell reader's launched-command view — `commandCliNames` sees
 *  the same command words the session planes count starts on, so a
 *  caller resolving "which cli does this template launch" can never
 *  drift from what the caps enforce. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { commandCliNames, commandWorkerClis } from './shell.ts';

describe('commandCliNames', () => {
  test('the bare command is its own cli', () => {
    assert.deepEqual(commandCliNames('devin'), ['devin']);
    assert.deepEqual(commandCliNames('devin -p "do the thing"'), ['devin']);
    assert.deepEqual(commandCliNames('/usr/local/bin/devin acp'), ['devin']);
  });

  test('nothing launched is an empty list', () => {
    assert.deepEqual(commandCliNames(''), []);
    assert.deepEqual(commandCliNames('   '), []);
    assert.deepEqual(commandCliNames('FOO=bar'), []);
  });

  test('every segment contributes its command', () => {
    assert.deepEqual(commandCliNames('devin a & devin b'), ['devin', 'devin']);
    assert.deepEqual(commandCliNames('cd /tmp; devin -p a | tee log'), ['cd', 'devin', 'tee']);
  });

  test('assignments and wrappers are skipped, not launched', () => {
    assert.deepEqual(commandCliNames('FOO=bar devin -p a'), ['devin']);
    assert.deepEqual(commandCliNames('env -i devin -p a'), ['devin']);
    assert.deepEqual(commandCliNames('env V=1 nice -n 5 timeout 30 devin -p a'), ['devin']);
    assert.deepEqual(commandCliNames('nohup devin -p a'), ['devin']);
    assert.deepEqual(commandCliNames('sudo -u root devin -p a'), ['devin']);
    assert.deepEqual(commandCliNames('npx devin -p a'), ['devin']);
  });

  test('a shell -c script launches the commands it carries', () => {
    assert.deepEqual(commandCliNames("sh -c 'devin -p a'"), ['devin']);
    assert.deepEqual(commandCliNames('bash -c "devin -p a"'), ['devin']);
    assert.deepEqual(commandCliNames("bash -lc 'devin -p a'"), ['devin']);
    assert.deepEqual(commandCliNames("FOO=1 sh -c 'devin -p a' & devin -p b"), ['devin', 'devin']);
    // the script is a segment list of its own
    assert.deepEqual(commandCliNames("sh -c 'devin a & claude b'"), ['devin', 'claude']);
    // nested -c unwraps while the depth cap allows — a layer too deep
    // leaves the shell itself as the command word (the plane stops
    // reading there too, so no start is counted either)
    assert.deepEqual(commandCliNames(`sh -c "sh -c 'devin'"`), ['devin']);
    assert.deepEqual(commandCliNames(`sh -c "sh -c \\"sh -c 'devin'\\""`), ['sh']);
  });

  test('a cli named only as an argument is not a launch', () => {
    assert.deepEqual(commandCliNames('echo devin'), ['echo']);
    assert.deepEqual(commandCliNames("sh -c 'echo devin'"), ['echo']);
    assert.deepEqual(commandCliNames('grep devin .git/bro/agents.json'), ['grep']);
    assert.deepEqual(commandCliNames("bro acp-worker --command 'devin acp'"), ['bro']);
    assert.deepEqual(commandCliNames('command -v devin'), ['command']);
  });

  test('a separator inside a quoted argument does not split', () => {
    assert.deepEqual(commandCliNames('devin -p "run devin later; then stop"'), ['devin']);
  });

  test('shell options ahead of -c still reach the script', () => {
    assert.deepEqual(commandCliNames("bash -l -c 'devin -p a'"), ['devin']);
    assert.deepEqual(commandCliNames("bash -e -c 'devin -p a'"), ['devin']);
    // -o/-O take the NEXT token as the option's value — it is not the script
    assert.deepEqual(commandCliNames("bash -o errexit -c 'devin -p a'"), ['devin']);
    assert.deepEqual(commandCliNames("bash -lo errexit -c 'devin -p a'"), ['devin']);
    // the first operand is a FILE the shell runs — a -c behind it is
    // the script's own argument, not a command line
    assert.deepEqual(commandCliNames("bash setup.sh -c 'devin -p a'"), ['bash']);
  });

  test('an unquoted -c operand is still the command — its positionals are not', () => {
    assert.deepEqual(commandCliNames('bash -c devin'), ['devin']);
    assert.deepEqual(commandCliNames('sh -c devin'), ['devin']);
    // later positionals are the script's $0/args — never part of it
    assert.deepEqual(commandCliNames('bash -c devin argv0 --x'), ['devin']);
  });

  test('a # outside quotes comments the rest of the line out', () => {
    // the ; inside the comment splits nothing — claude never runs
    assert.deepEqual(commandCliNames('devin a # note; claude b'), ['devin']);
    // the comment ends at the newline — which itself separates
    assert.deepEqual(commandCliNames('devin a # note\nclaude b'), ['devin', 'claude']);
    // inside a word or a quote the # is text
    assert.deepEqual(commandCliNames('devin -p "#tag"'), ['devin']);
    assert.deepEqual(commandCliNames('x#y -p a'), ['x#y']);
  });

  test('an escaped char is word text — no comment, no split', () => {
    // `\ ` keeps the word open — the # behind it is an argument, and
    // the real devin launch on the next segment is not commented away
    assert.deepEqual(commandCliNames('echo \\ #; devin -p x'), ['echo', 'devin']);
    // `\;` separates nothing — claude is devin's argument, not a command
    assert.deepEqual(commandCliNames('devin a\\; claude b'), ['devin']);
    // `\"` stays inside a double-quoted run — the -c script carries
    // one devin launch, and the `;` inside it splits nothing
    assert.deepEqual(commandCliNames('sh -c "devin \\"; claude\\""'), ['devin']);
  });

  test('a backslash-newline is a continuation — the joined command still launches', () => {
    // `\<newline>` is removed, not a separator: `cd && \`␤`devin` runs
    // devin — splitting there hid the start from the caps (greptile PR
    // #1094)
    assert.deepEqual(commandCliNames('cd /tmp && \\\ndevin -p a'), ['cd', 'devin']);
    // mid-word the continuation joins the name — bash runs `devin`
    assert.deepEqual(commandCliNames('dev\\\nin -p a'), ['devin']);
    // the continuation lands the comment where the words join
    assert.deepEqual(commandCliNames('echo a \\\n# note\ndevin -p x'), ['echo', 'devin']);
    // inside a double-quoted -c script the pair vanishes too — the
    // inner shell never sees a newline separator
    assert.deepEqual(commandCliNames('sh -c "devin -p \\\nx"'), ['devin']);
  });

  test('a descriptor redirection is not a command separator', () => {
    // `2>&1` is one redirection — the `1` is no cli, so a provider
    // entry sharing `… 2>&1` cannot gate an unrelated worker on it
    assert.deepEqual(commandCliNames('devin -p x 2>&1'), ['devin']);
    assert.deepEqual(commandCliNames('other-cli x 2>&1'), ['other-cli']);
    // `&>`/`&>>` fold stdout+stderr into one redirect — still one command
    assert.deepEqual(commandCliNames('devin -p x &> run.log'), ['devin']);
    // a standalone `&` still separates — and `|&` is the stderr pipeline
    assert.deepEqual(commandCliNames('devin a & other-cli b'), ['devin', 'other-cli']);
    assert.deepEqual(commandCliNames('devin a |& tee log'), ['devin', 'tee']);
  });

  test('an ESCAPED angle is text — the & behind it still separates (greptile PR #1094)', () => {
    // `\>` is a literal `>` in echo's argument — the `&` that follows
    // is a background separator, so devin runs on its own clause
    assert.deepEqual(commandCliNames('echo \\>& devin -p x'), ['echo', 'devin']);
    // `&&` then `>` — the second `&` completes the operator, it does
    // not open a `&>` fold; `>/dev/null` is the next clause's redirect
    assert.deepEqual(commandCliNames('true &&>/dev/null devin -p x'), ['true', 'devin']);
    // `>|` is the noclobber write — the `|` is the op's tail, not a
    // pipe, and a provider named as its FILE launches nothing
    assert.deepEqual(commandCliNames('devin -p x >| run.log'), ['devin']);
    assert.deepEqual(commandCliNames('echo hi >|devin'), ['echo']);
  });

  test('a leading redirection still names the command (coderabbit PR #1094)', () => {
    // the shell redirects output and launches worker-cli — `>run.log`
    // is plumbing, not the executable
    assert.deepEqual(commandCliNames('>run.log worker-cli run'), ['worker-cli']);
    assert.deepEqual(commandCliNames('2> err.log worker-cli run'), ['worker-cli']);
    assert.deepEqual(commandCliNames('worker-cli run > out.log 2>&1'), ['worker-cli']);
    // interleaved between the command and its args it's still plumbing
    assert.deepEqual(commandCliNames('worker-cli > out.log run'), ['worker-cli']);
    // a quoted or escaped angle is a WORD, never an operator
    assert.deepEqual(commandCliNames("'>' worker-cli"), ['>']);
    assert.deepEqual(commandCliNames('\\> worker-cli'), ['>']);
    assert.deepEqual(commandCliNames('worker-cli run > log; devin -p x'), ['worker-cli', 'devin']);
  });

  test('an escaped space stays inside the -c script operand (coderabbit PR #1094)', () => {
    // `worker-cli\ run` is ONE operand — the script the inner shell
    // parses as `worker-cli run`
    assert.deepEqual(commandCliNames('sh -c worker-cli\\ run'), ['worker-cli']);
    assert.deepEqual(commandCliNames('bash -c devin\\ -p'), ['devin']);
    // outside -c the escape glues too — one word, not two
    assert.deepEqual(commandCliNames('worker-cli\\ run x'), ['worker-cli run']);
  });

  test('a here-document body is data, not commands (coderabbit PR #1094)', () => {
    // the body line reads like a launch but feeds cat — `devin` never runs
    assert.deepEqual(commandCliNames('cat <<EOF\nworker-cli run\nEOF'), ['cat']);
    assert.deepEqual(commandCliNames("cat <<'EOF'\nworker-cli run\nEOF"), ['cat']);
    // scanning resumes after the delimiter — the devin below is real
    assert.deepEqual(commandCliNames("cat <<'EOF'\nworker-cli run\nEOF\ndevin -p x"), [
      'cat',
      'devin',
    ]);
    // `<<-` folds leading tabs out of the body and the delimiter line
    assert.deepEqual(commandCliNames('cat <<-EOF\n\tworker-cli run\n\tEOF'), ['cat']);
    // `<<<` is a herestring — one word of data, no body lines at all
    assert.deepEqual(commandCliNames('cat <<<"worker-cli"\ndevin -p x'), ['cat', 'devin']);
    // two heredocs on one line consume their bodies in order
    assert.deepEqual(commandCliNames('cat <<A <<B\nworker-cli\nA\nother-cli\nB\ndevin -p x'), [
      'cat',
      'devin',
    ]);
    // a same-line command behind the op still counts
    assert.deepEqual(commandCliNames('cat <<EOF; devin -p x\nbody\nEOF'), ['cat', 'devin']);
  });

  test('a backslash inside double quotes escapes only the five chars bash says', () => {
    // `\;` inside a double-quoted -c script stays literal — the INNER
    // shell sees `printf %s \; devin -p x` and runs only printf
    // (devin is printf's argument — no launch, no provider lane)
    assert.deepEqual(commandCliNames('bash -c "printf %s \\; devin -p x"'), ['printf']);
    // the real escapes still decode: `\\` → `\`, `\"` stays inside
    assert.deepEqual(commandCliNames('bash -c "devin -p a"'), ['devin']);
  });

  test('an explicitly quoted empty -c operand is a real token', () => {
    // `bash -c '' devin` runs an EMPTY script — `devin` is its $0, no
    // launch. Dropping the empty token read `devin` as the script
    assert.deepEqual(commandCliNames("bash -c '' devin"), []);
    assert.deepEqual(commandCliNames('bash -c "" devin'), []);
    // a quoted empty word elsewhere is just an argument
    assert.deepEqual(commandCliNames("devin -p ''"), ['devin']);
    assert.deepEqual(commandCliNames("'' devin"), []);
  });

  test('a here-document feeding a shell is the program (greptile PR #1094)', () => {
    // `sh <<EOF` reads its SCRIPT from stdin — the body launches what
    // it names, the way `sh -c '…'` does
    assert.deepEqual(commandCliNames("sh <<'EOF'\ndevin -p x\nEOF"), ['devin']);
    assert.deepEqual(commandCliNames('sh <<EOF\ndevin -p x\nother-cli b\nEOF'), [
      'devin',
      'other-cli',
    ]);
    // scanning resumes after the delimiter — claude is real
    assert.deepEqual(commandCliNames('sh <<EOF\ndevin -p x\nEOF\nclaude b'), ['devin', 'claude']);
    // `sh -s` still reads stdin — operands after it are positional
    assert.deepEqual(commandCliNames('sh -s x <<EOF\ndevin -p a\nEOF'), ['devin']);
    // feeding anything else the body is DATA — cat swallows it, a file
    // operand makes it the script's own stdin, and a -c operand wins
    assert.deepEqual(commandCliNames('cat <<EOF\ndevin -p x\nEOF'), ['cat']);
    assert.deepEqual(commandCliNames('bash setup.sh <<EOF\ndevin -p x\nEOF'), ['bash']);
    assert.deepEqual(commandCliNames("sh -c 'echo hi' <<EOF\ndevin -p x\nEOF"), ['echo']);
    // the `<<` binds the segment it sits in — the heredoc feeds cat's
    // stdin while sh runs on the pipe (cat is no shell — data stays data)
    assert.deepEqual(commandCliNames('cat <<EOF | sh\ndevin -p x\nEOF'), ['cat', 'sh']);
  });

  test('unquoted subshell parens bound commands (coderabbit PR #1094)', () => {
    // `(…) &` is a backgrounded subshell — the commands inside run
    assert.deepEqual(commandCliNames('(devin -p x) & wait'), ['devin', 'wait']);
    assert.deepEqual(commandCliNames('(devin -p a; claude b)'), ['devin', 'claude']);
    // a command substitution runs its innards too
    assert.deepEqual(commandCliNames('x=$(devin -p a)'), ['devin']);
    // quoted or escaped parens are word text
    assert.deepEqual(commandCliNames("echo '(devin -p x)'"), ['echo']);
    assert.deepEqual(commandCliNames('devin -p \\(x\\)'), ['devin']);
    // `if`/`while`/`!` precede the command the shell runs — they are
    // keywords, not the launch
    assert.deepEqual(commandCliNames('if devin -p x; then echo ok; fi'), ['devin', 'echo']);
    assert.deepEqual(commandCliNames('! devin -p x'), ['devin']);
    assert.deepEqual(commandCliNames('while devin -p x; do echo ok; done'), ['devin', 'echo']);
  });

  test('a redirection glued to a word still splits (coderabbit PR #1094)', () => {
    // `worker-cli>run.log` runs `worker-cli` — the angle needs no
    // whitespace ahead of it
    assert.deepEqual(commandCliNames('worker-cli>run.log run'), ['worker-cli']);
    assert.deepEqual(commandCliNames('devin>log -p x'), ['devin']);
    assert.deepEqual(commandCliNames('devin -p x>log'), ['devin']);
    // `&>` glued to the command word too
    assert.deepEqual(commandCliNames('worker-cli&>run.log run'), ['worker-cli']);
    // a bare digit run ahead of the angle is the op's fd prefix, not a
    // word — `2>err` rebinds stderr and still names the command
    assert.deepEqual(commandCliNames('devin 2>err -p x'), ['devin']);
    assert.deepEqual(commandCliNames('2>err worker-cli run'), ['worker-cli']);
    // two redirects glued together split at each op
    assert.deepEqual(commandCliNames('worker-cli>out>err run'), ['worker-cli']);
    // an escaped or quoted angle stays word text
    assert.deepEqual(commandCliNames('worker-cli\\>log run'), ['worker-cli>log']);
    assert.deepEqual(commandCliNames("'devin>x' -p a"), ['devin>x']);
  });

  test('an empty attached here-string operand keeps the next word (coderabbit PR #1094)', () => {
    // `<<<''` carries an EMPTY quoted operand — `list` is devin's
    // argument, not the here-string: both spellings read alike
    assert.deepEqual(commandCliNames("devin <<<'' list"), ['devin']);
    assert.deepEqual(commandCliNames("devin <<< '' list"), ['devin']);
    // a detached op still takes its word from the next token
    assert.deepEqual(commandCliNames('devin <<< list'), ['devin']);
  });

  test('wrapper option reading sees through redirects (coderabbit PR #1094)', () => {
    // `command >log -v devin` is a LOOKUP — `>log` is plumbing, `-v`
    // is the flag; nothing launches
    assert.deepEqual(commandCliNames('command >log -v devin'), ['command']);
    // the runner form still resolves past the redirect
    assert.deepEqual(commandCliNames('command >log devin -p x'), ['devin']);
    // `--` ends option parsing — what follows is the command even
    // when it reads like a flag
    assert.deepEqual(commandCliNames('sudo -- devin -p x'), ['devin']);
    assert.deepEqual(commandCliNames('command -- devin -p x'), ['devin']);
  });

  test('escaped quotes inside a heredoc delimiter decode (coderabbit PR #1094)', () => {
    // `<<"E\"OF"` delimits on E"OF — the escaped quote does not close
    // the run, so the body below it stays body and the devin AFTER
    // the delimiter is the real launch
    assert.deepEqual(commandCliNames('cat <<"E\\"OF"\ndevin -p x\nE"OF\ndevin real'), [
      'cat',
      'devin',
    ]);
    // a single-quoted run decodes nothing — `\` stays literal
    assert.deepEqual(commandCliNames("cat <<'E\\OF'\nx\nE\\OF\ndevin -p a"), ['cat', 'devin']);
  });
});

describe('commandWorkerClis', () => {
  test('the scaffolding around the worker drops out', () => {
    assert.deepEqual(commandWorkerClis('cd /tmp && devin -p a'), ['devin']);
    assert.deepEqual(commandWorkerClis('devin -p a; echo done'), ['devin']);
    assert.deepEqual(commandWorkerClis('git pull && devin -p a | tee log'), ['devin']);
    assert.deepEqual(commandWorkerClis('cd /tmp && env F=1 devin -p a; echo done'), ['devin']);
  });

  test('a command whose every cli is scaffolding keeps them all', () => {
    // an exotic worker named like a builtin still identifies itself —
    // dropping everything would make the worker unnamable
    assert.deepEqual(commandWorkerClis('cd /tmp && test -f x'), ['cd', 'test']);
    assert.deepEqual(commandWorkerClis(''), []);
  });
});

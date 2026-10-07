import { describe, expect, it } from 'vitest';
import { shellWrites } from '../../src/gate/shell';

const env = { home: '/home/u', vars: { TMPDIR: '/tmp/t' } };
const writes = (command: string) => shellWrites(command, '/p', env);
const targets = (command: string) =>
  writes(command).targets.map((target) => target.path ?? (target.temp ? 'temp' : `? ${target.unresolved}`));

describe('shellWrites', () => {
  it.each([
    ['echo hi > out.txt', ['/p/out.txt']],
    ['echo hi >> logs/a.log 2>&1', ['/p/logs/a.log']],
    ['cmd &> all.txt', ['/p/all.txt']],
    ['echo a 1>out 2>err', ['/p/out', '/p/err']],
    ['cat a > /dev/null 2>/dev/stderr', []],
    ['echo x | tee -a one.txt two.txt', ['/p/one.txt', '/p/two.txt']],
    ['rm -rf build dist', ['/p/build', '/p/dist']],
    ['touch -t 202601010000 stamp.txt', ['/p/stamp.txt']],
    ['truncate -s 0 big.log', ['/p/big.log']],
    ['chmod +x run.sh', ['/p/run.sh']],
    ['chown user:staff a.txt b.txt', ['/p/a.txt', '/p/b.txt']],
    ['echo "a > b" && ls -la', []],
    ['ls -la; grep -r foo src; npm test', []],
    ['echo > ~/notes.txt', ['/home/u/notes.txt']],
    ['echo > /abs/x.txt', ['/abs/x.txt']],
    ['[[ 1 ]] > .env', ['/p/.env']],
    ['r\\\nm "\\\n.env"', ['/p/.env']],
    ["git push origin {a,b} && git commit -m $'a\\nb'", []],
    ['rm .e{m..o}v', ['? brace expansion']],
  ])('%s', (command, expected) => {
    expect(targets(command)).toEqual(expected);
  });

  it.each([
    ['rm src/a.ts', [{ path: '/p/src/a.ts', deleting: true }]],
    ['rmdir old', [{ path: '/p/old', deleting: true }]],
    ['unlink a.ts', [{ path: '/p/a.ts', deleting: true }]],
    ['mv src/a.ts src/b.ts', [{ path: '/p/src/a.ts', deleting: true }, { path: '/p/src/b.ts', deleting: false }]],
    ['cp a.ts b.ts', [{ path: '/p/b.ts', deleting: false }]],
    ['git rm a.ts b.ts', [{ path: '/p/a.ts', deleting: true }, { path: '/p/b.ts', deleting: true }]],
    ['git rm -r --cached a.ts', []],
    ['git rm --cached a.ts', []],
    ['git -c x=y rm a.ts', [{ path: '/p/a.ts', deleting: true }]],
    ['git mv a b', [{ path: '/p/a', deleting: true }, { path: '/p/b', deleting: false }]],
    ['cp -tout a.ts', [{ path: '/p/out', deleting: false }]],
    ['echo $(echo ")") > out.ts', [{ path: '/p/out.ts', deleting: false }]],
    ["echo hi > $'a.ts'", [{ path: '/p/a.ts', deleting: false }]],
    ['echo hi > a.ts', [{ path: '/p/a.ts', deleting: false }]],
  ])('deleting flags of %s', (command, expected) => {
    const got = writes(command).targets.filter((target) => target.path).map((target) => ({ path: target.path, deleting: target.deleting }));
    expect(got).toEqual(expected);
  });

  it.each([
    ['cp -t out a.ts', 'out'],
    ['cp -tout a.ts', 'out'],
    ['mv -tout a.ts', 'out'],
    ['mv --target-directory=out a.ts', 'out'],
  ])('%s lands a.ts in the target directory', (command, dir) => {
    expect(writes(command).targets.filter((target) => !target.deleting).map((target) => [target.path, target.names])).toEqual([[`/p/${dir}`, ['a.ts']]]);
  });

  it.each([
    'source s.sh', '. s.sh', "bash -c -- 'touch x'", 'echo x > ~other/f.ts', "echo x > $'a\\n.ts'", 'echo x > $\'a\\x41.ts\'', 'echo x > ~+/f.ts',
    'git log -1 {--output=.env,}', 'git log -1 $"--output=.env"',
  ])('%s has an unresolved target', (command) => {
    expect(writes(command).targets.some((target) => target.unresolved !== null)).toBe(true);
  });

  it('a mktemp variable followed by .. is not temp', () => {
    const got = writes('T=$(mktemp -d); echo x > $T/../../proj/f.ts');
    expect(got.targets.every((target) => !target.temp)).toBe(true);
    expect(got.targets.length).toBe(1);
  });

  it.each([
    '$T/../../proj/$X',
    '$T/../*',
    '$T/../../t/x',
    '$T/$X/../../f',
    '$T/{a,../../x}',
  ])('a mktemp variable in %s leaves the temporary directory', (path) => {
    const got = writes(`T=$(mktemp -d); echo x > ${path}`).targets;
    expect(got.map((target) => [target.temp, target.unresolved !== null])).toEqual([[false, true]]);
  });

  it.each(['$T/sub/../f', '$T/a/b.txt', '$T/$X/f'])('a mktemp variable in %s stays temp', (path) => {
    expect(writes(`T=$(mktemp -d); echo x > ${path}`).targets.map((target) => target.temp)).toEqual([true]);
  });

  it.each([
    'git -C sub rm a.ts',
    'git --git-dir=x rm a.ts',
    'git --work-tree=w mv a b',
    'git rm --pathspec-from-file=list',
    'git mv --pathspec-from-file list',
  ])('%s is unresolved, not resolved against the wrong directory', (command) => {
    expect(writes(command).targets.map((target) => [target.path, target.unresolved !== null])).toEqual([[null, true]]);
  });

  it('git rm -- --cached removes a file named --cached', () => {
    expect(writes('git rm -- --cached').targets.map((target) => [target.path, target.deleting])).toEqual([['/p/--cached', true]]);
  });

  it.each([
    ['cp -rt out a.ts'],
    ['mv -ft out a.ts'],
  ])('%s lands a.ts in out and never counts out as a source', (command) => {
    expect(writes(command).targets.map((target) => [target.path, target.deleting, target.names])).toEqual(
      command.startsWith('mv') ? [['/p/a.ts', true, []], ['/p/out', false, ['a.ts']]] : [['/p/out', false, ['a.ts']]],
    );
  });

  it('a mktemp variable with a plain path below it stays temp', () => {
    expect(writes('T=$(mktemp -d); echo x > $T/a/b.txt').targets.map((target) => target.temp)).toEqual([true]);
  });

  it('marks mkdir targets so a planned directory tree can be created', () => {
    expect(writes('mkdir -p a/b').targets).toMatchObject([{ path: '/p/a/b', mkdir: true }]);
  });

  it('counts mv sources and the destination, and the names that land in a destination directory', () => {
    expect(writes('mv a.txt b.txt docs/').targets.map((target) => [target.path, target.names])).toEqual([
      ['/p/a.txt', []],
      ['/p/b.txt', []],
      ['/p/docs', ['a.txt', 'b.txt']],
    ]);
  });

  it('counts only the cp destination, also with -t', () => {
    expect(targets('cp -r src/ backup')).toEqual(['/p/backup']);
    expect(targets('cp -t out a.txt')).toEqual(['/p/out']);
  });

  it('finds the files of sed -i in its GNU and BSD forms, and nothing without -i', () => {
    expect(targets("sed -i 's/a/b/' f1 f2")).toEqual(['/p/f1', '/p/f2']);
    expect(targets("sed -i '' -e 's/a/b/' f")).toEqual(['/p/f']);
    expect(targets('sed -n -e p -i.bak g')).toEqual(['/p/g']);
    expect(targets("sed 's/a/b/' f")).toEqual([]);
  });

  it('follows cd, and restores the directory after a subshell', () => {
    expect(targets('cd sub && echo > x; (cd deeper && echo > y); echo > z')).toEqual(['/p/sub/x', '/p/sub/deeper/y', '/p/sub/z']);
  });

  it('cannot resolve a relative path after a cd into a variable', () => {
    expect(targets('cd "$DIR" && rm x')).toEqual(['? a relative path after a cd CodeRay cannot follow']);
  });

  it('substitutes $TMPDIR and $TMP, and leaves other variables unresolved', () => {
    expect(targets('echo > $TMPDIR/x; echo > "$OUT"')).toEqual(['/tmp/t/x', '? the variable $OUT']);
  });

  it('treats a variable from a plain mktemp as temp, but not one from a template in the working directory', () => {
    expect(targets('T=$(mktemp -d); echo hi > "$T/f"')).toEqual(['temp']);
    expect(targets('T=$(mktemp foo.XXXX); echo hi > $T')).toEqual(['? the variable $T']);
  });

  it('leaves wildcards unresolved but reads quoted wildcard characters literally', () => {
    expect(targets('rm *.log')).toEqual(['? a wildcard']);
    expect(targets('echo > "a*b.txt"')).toEqual(['/p/a*b.txt']);
  });

  it('skips heredoc bodies', () => {
    expect(targets("cat <<'EOF' > gen.ts\nexport const a = 1 > 0 ? 'x' : 'y';\nEOF\necho done > log.txt")).toEqual(['/p/gen.ts', '/p/log.txt']);
  });

  it('reads the script of sh -c and command substitutions', () => {
    expect(targets("bash -c 'echo > inner.txt'")).toEqual(['/p/inner.txt']);
    expect(targets('echo $(echo hi > sub.txt)')).toEqual(['/p/sub.txt']);
    expect(targets('sh -c "$CMD"')).toEqual(['? a shell script CodeRay cannot read']);
  });

  it('marks git commands that rewrite the work tree, and no others', () => {
    expect(writes('git checkout main').allTracked).toBe(true);
    expect(writes('git -C sub reset --hard').allTracked).toBe(true);
    expect(writes('git revert HEAD').allTracked).toBe(true);
    expect(writes('git status && git log --oneline && git commit -m "a > b"').allTracked).toBe(false);
  });

  it.each([
    ['git reset --hard', ['/p']],
    ['cd sub && git reset --hard', ['/p/sub']],
    ['git -C sub reset --hard', ['/p/sub']],
    ['git -C /abs/wt checkout main', ['/abs/wt']],
    ['git -C a -C b reset --hard', ['/p/a/b']],
    ['git -C a -C /abs/b reset --hard', ['/abs/b']],
    ['git -C sub reset --hard && git checkout .', ['/p/sub', '/p']],
    ['git --work-tree w checkout .', [null]],
    ['git --work-tree=w checkout .', [null]],
    ['git --git-dir x -C sub reset --hard', [null]],
    ['git --git-dir=x reset --hard', [null]],
    ['git -C "$D" reset --hard', [null]],
    ['cd "$D" && git reset --hard', [null]],
    ['cd "$D" && git -C sub reset --hard', [null]],
    ['cd "$D" && git -C /abs/wt reset --hard', ['/abs/wt']],
    ['git status && git -C sub log', []],
  ])('%s moves history in %j', (command, dirs) => {
    expect(writes(command).history).toEqual(dirs);
  });

  it('judges git in both directories wherever a cd may not run: after && or ||, in a pipeline or the background, in a block, and after a function, an alias or CDPATH', () => {
    const rows: [command: string, history: string[], rewrites: string[]][] = [
      ['cd sub && git reset --hard', ['/p/sub'], []],
      ['false && cd sub; git reset --hard', ['/p', '/p/sub'], []],
      ['cd sub & git reset --hard', ['/p', '/p/sub'], []],
      ['git status | cd sub; git reset --hard', ['/p', '/p/sub'], []],
      ['if true; then cd sub; fi; git reset --hard', ['/p', '/p/sub'], []],
      ['f() { :; }; cd sub && git reset --hard', [], ['/p', '/p/sub']],
      ['alias cd=true; cd sub && git reset --hard', [], ['/p', '/p/sub']],
      ['CDPATH=/x cd sub && git reset --hard', [], ['/p', '/p/sub']],
    ];
    expect(rows.map(([command]) => [command, writes(command).history, writes(command).rewrites])).toEqual(rows);
  });

  it('reads each of checkout, switch, reset, pull, merge, rebase, cherry-pick and revert as history, and none as a work tree rewrite', () => {
    const verbs = ['checkout', 'switch', 'reset', 'pull', 'merge', 'rebase', 'cherry-pick', 'revert'];
    expect(verbs.map((verb) => [verb, writes(`git ${verb} x`).history, writes(`git ${verb} x`).rewrites])).toEqual(verbs.map((verb) => [verb, ['/p'], []]));
  });

  it('cannot say where git runs once a GIT_ variable is set, however it is set, so the call rewrites a work tree nobody named', () => {
    for (const command of ['GIT_DIR=x git reset --hard', 'export GIT_WORK_TREE=w; git checkout main', 'env GIT_DIR=x git rebase main', 'cd sub && GIT_INDEX_FILE=i git merge main']) {
      expect([command, writes(command).rewrites, writes(command).history]).toEqual([command, [null], []]);
    }
    for (const command of ['GIT_DIR=x git rm a.ts', 'export GIT_WORK_TREE=w; git mv a b']) {
      expect([command, writes(command).targets.map((target) => [target.path, target.unresolved !== null])]).toEqual([command, [[null, true]]]);
    }
  });

  it('keeps restore, clean, stash, apply and am as work tree rewrites, apart from the history commands', () => {
    expect(writes('git restore . && git -C sub stash && git clean -fd && git am p.patch && git apply p.patch').rewrites).toEqual(['/p', '/p', '/p', '/p', '/p/sub']);
    expect([writes('git restore .').history, writes('git rebase main').rewrites]).toEqual([[], []]);
  });

  it('keeps an earlier rewrite when a later git apply only touches the index, and the other way round', () => {
    expect(writes('git restore . && git apply --cached p.patch').rewrites).toEqual(['/p']);
    expect(writes('git apply --cached p.patch && git restore .').rewrites).toEqual(['/p']);
    expect(writes('git restore . && git apply --cached p.patch').allTracked).toBe(true);
  });

  it('does not mark git apply that only touches the index', () => {
    expect([writes('git apply --cached p.patch').allTracked, writes('git apply --cached --index p.patch').allTracked, writes('git apply p.patch').allTracked]).toEqual([false, true, true]);
  });

  it('lets xargs git rm --cached through and keeps every other xargs git writer unresolved', () => {
    const unresolved = ['? xargs runs a command that writes files it reads from its input'];
    expect(targets('git ls-files | xargs git rm -q --cached')).toEqual([]);
    expect(targets('git ls-files | xargs -0 git add')).toEqual([]);
    expect(targets('git ls-files | xargs git rm')).toEqual(unresolved);
    expect(targets('git ls-files | xargs git rm -- --cached')).toEqual(unresolved);
    expect(targets('git ls-files | xargs git mv')).toEqual(unresolved);
    expect(writes('ls | xargs git checkout').allTracked).toBe(true);
  });

  it('leaves find -delete, find -exec rm, xargs rm and eval unresolved', () => {
    expect(targets("find . -name '*.tmp' -delete")).toEqual(['? find deletes or changes the files it finds']);
    expect(targets('find . -exec rm {} \\;')).toEqual(['? find deletes or changes the files it finds']);
    expect(targets('ls | xargs -n 1 rm')).toEqual(['? xargs runs a command that writes files it reads from its input']);
    expect(targets('eval "$X"')).toEqual(['? eval runs text CodeRay cannot read']);
  });

  it('looks through sudo, env and keywords to the command', () => {
    expect(targets('sudo -u root rm /etc/x; env A=1 touch t; if true; then rm y; fi')).toEqual(['/etc/x', '/p/t', '/p/y']);
  });

  it('does not read comparisons in [[ ]] and (( )) as redirections', () => {
    expect(targets('[[ "$a" > "$b" ]] && echo ok; (( i > 0 ))')).toEqual([]);
  });

  it('ignores comments', () => {
    expect(targets('ls # > not-a-file')).toEqual([]);
  });

  it('treats "((" as two subshell opens unless the inner paren closes as arithmetic', () => {
    expect(targets('((cd a && make) || rm -rf b); rm -rf c')).toEqual(['/p/b', '/p/c']);
    expect(targets('(( i > 0 )) && rm -rf d')).toEqual(['/p/d']);
  });

  it('finds the chmod target when the mode itself looks like an option', () => {
    expect(targets('chmod -x f')).toEqual(['/p/f']);
    expect(targets('chmod -R -w dir')).toEqual(['/p/dir']);
  });

  it('scans every find -exec, looks through wrappers, and counts a shell as a writer', () => {
    expect(targets('find . -name x -exec echo {} \\; -exec rm {} \\;')).toEqual(['? find deletes or changes the files it finds']);
    expect(targets('find . -exec sudo rm {} \\;')).toEqual(['? find deletes or changes the files it finds']);
    expect(targets("find . -exec sh -c 'rm \"$0\"' {} \\;")).toEqual(['? find deletes or changes the files it finds']);
  });

  it('counts a shell run by xargs as a writer', () => {
    expect(targets("ls | xargs sh -c 'rm $0'")).toEqual(['? xargs runs a command that writes files it reads from its input']);
  });

  it('treats TMPDIR, TMP and HOME as unresolved once the command reassigns them', () => {
    expect(targets('TMPDIR=/p/src; rm -rf $TMPDIR/core')).toEqual(['? the variable $TMPDIR']);
    expect(targets('export TMPDIR=$PWD/tmp; echo > $TMPDIR/log')).toEqual(['? the variable $TMPDIR']);
    expect(targets('HOME=/p; rm -rf ~/src')).toEqual(['? the variable $HOME']);
  });

  it('accepts sudo and env assignments with a non-literal value, and gives exec -a its value', () => {
    expect(targets('env A=$X rm y')).toEqual(['/p/y']);
    expect(targets('sudo FOO=bar rm -rf /x')).toEqual(['/x']);
    expect(targets('exec -a nm rm x')).toEqual(['/p/x']);
  });

  it('treats >& file, >|, &>> and <> as write targets', () => {
    expect(targets('cmd >& out.txt')).toEqual(['/p/out.txt']);
    expect(targets('cmd >| out.txt')).toEqual(['/p/out.txt']);
    expect(targets('cmd &>> out.txt')).toEqual(['/p/out.txt']);
    expect(targets('cmd <> out.txt')).toEqual(['/p/out.txt']);
  });
});

describe('shellWrites moves', () => {
  const moves = (command: string) => writes(command).moves;

  it.each([
    'rm a', 'rmdir a', 'unlink a', 'mv a b', 'cp a b', 'cp -n a b', 'cp --recursive --force a b', 'cp -r --target-directory=d a', 'mv -t d a', 'echo x | tee a', 'touch a', 'mkdir a', 'truncate -s 0 a', 'chmod +x a', 'chown u a', 'chgrp g a',
  ])('reports the history a call moves when it goes on to write only files it names, as in %s', (writer) => {
    expect(moves(`git -C wt reset --hard && ${writer}`)).toEqual(['/p/wt']);
  });

  it('keeps a pure call that commits as history, as the gate has always judged it, and reports no moves for it', () => {
    const pure = writes('git -C wt commit -qm x && git -C wt reset --hard HEAD~1');
    expect([pure.history, pure.moves]).toEqual([['/p/wt'], []]);
  });

  it.each([
    "cd wt && echo evil > /tmp/x && sed -n 'w src/evil.py' /tmp/x && git add -A && git commit -qm w && git reset -q",
    'git -C wt reset --hard && sed -i s/a/b/ a',
    'git -C wt reset --hard && sed -i.py s/a/b/ a',
    "git -C wt reset --hard && sed -i '1e cmd' a",
    "git -C wt reset --hard && sed -n 'w out' in",
    'git -C wt reset --hard && cp -b -S .py x P',
    'git -C wt reset --hard && cp -bS.py x P',
    'git -C wt reset --hard && cp --backup=numbered x P',
    'git -C wt reset --hard && mv -b a b',
    'git -C wt reset --hard && mv --suffix=.py a b',
    'git -C wt reset --hard o && cp --suf=.x a b',
    'git -C wt reset --hard o && cp --back a b',
    'git -C wt reset --hard o && cp --b a b',
    'git -C wt reset --hard o && mv --ba=t a b',
    'git -C wt reset --hard && cp --unknown-option a b',
    'git -C wt reset --hard && cp $OPTS x P',
    'git -C wt reset --hard && cp a b && git add -A && git commit -qm w',
    'git -C wt reset --hard && cp a b && git commit -qam w',
    'git -C wt reset --hard && cp a b && git stash push',
    'git -C wt reset --hard && cp a b && git stash pop',
    'git -C wt reset --hard && cp a b && git add b',
  ])('reports no moves, since what a commit or a stash takes in may come from a file no target names, for %s', (command) => {
    expect(moves(command)).toEqual([]);
  });

  it.each([
    'git -C wt reset --hard',
    'git -C wt checkout -- a && cp a b',
    'git -C wt clean -fd && cp a b',
    'git -C wt reset --hard && rm *.log',
    'git -C wt reset --hard && rm a *.log',
    'git -C wt reset --hard && eval "$X"',
    'git -C wt reset --hard && npm run gen',
    'git -C wt reset --hard && ./cp a b',
    'git -C wt reset --hard && $CMD a',
    'git -C wt reset --hard && ln -s a b',
    'git -C wt reset --hard && install a b',
    'git -C wt reset --hard && dd of=a',
    'git -C wt reset --hard && find . -fprint out',
    'git -C wt reset --hard && ls | xargs gen',
    'git -C wt reset --hard && ./gen && cp a b',
    'git -C wt reset --hard && f() { :; }',
    'git -C wt reset --hard && sudo cp a b',
    'git -C wt reset --hard && env X=1 cp a b',
    'git -C wt reset --hard && set -a',
    'git -C wt reset --hard && export x',
    'git -c core.hooksPath=h -C wt reset --hard',
    'git -C wt reset --hard && git config core.hooksPath h',
    'PATH=/x git -C wt reset --hard',
  ])('reports no moves for %s', (command) => {
    expect(moves(command)).toEqual([]);
  });

  it.each([
    'sed -n 45,60p f',
    "sed -n '/a/,/b/p' f",
    "sed '$!d' f",
    "sed 's/a/b/g' f",
    'sed -ne 5p f',
    "sed -nE 's/(a|b)+/x/p' f",
    'sed --quiet --expression=2,3p f',
    "sed -n -e 1p -e '2,+3p' -- f",
    'sed -e 1p -n f',
    'sed -n -e 1p f g',
    'sort -u f',
    'cut -d: -f1 f | tr a b; diff a b; jq .a f; stat f; basename x; dirname x',
    'rg -n x src | head',
  ])('keeps a merge as history, with no rewrites, when the call goes on to read with %s', (reader) => {
    const got = writes(`git merge --ff-only origin/x && ${reader}`);
    expect([got.history, got.rewrites, got.moves]).toEqual([['/p'], [], []]);
  });

  it.each([
    "sed 's/a/b/w out' f",
    "sed -n 'w out' f",
    'sed -n 1e f',
    "sed 's/a/b/e' f",
    'sed -i s/a/b/ f',
    'sed --in-place s/a/b/ f',
    'sed -f s.sed f',
    'sed -f p f',
    'sed -n 1p $F',
    "sed 's;a;b;;w x' f",
    "sed -n 'p;w out' f",
    "sed -n 'w out;p' f",
    "sed -n -e 1p -e 'w out' f",
    "sed 's/.*/H/w payload' -e 1p f",
    "sed 's/.*/H/w payload' --expression=1p f",
    "sed 's/.*/H/w payload' -ne 1p f",
    'sort -o f',
    'sort -uo f',
    'sort --out=f',
    'sort --compress-program=./x f',
    'sort $F',
    'rg --pre ./x x',
    'rg --hostname-bin ./x x',
  ])('judges a merge as a rewrite, with no moves, when the call goes on with %s, which may write what no target names', (writer) => {
    const got = writes(`git merge --ff-only origin/x && ${writer}`);
    expect([got.history, got.rewrites, got.moves]).toEqual([[], ['/p'], []]);
  });
});

describe('shellWrites for loops', () => {
  it.each([
    ['for f in linux macos windows; do docker compose -f docker-compose.$f.yml config 2>/tmp/err.$f && echo ok; done', ['/tmp/err.linux', '/tmp/err.macos', '/tmp/err.windows']],
    ['for f in a b; do rm src/$f; done', ['/p/src/a', '/p/src/b']],
    ['for a in 1 2; do for b in x y; do rm $a/$b; done; done', ['/p/1/x', '/p/1/y', '/p/2/x', '/p/2/y']],
    ['for f in a b; do rm ${f}.txt "$f".bak; done', ['/p/a.txt', '/p/b.txt', '/p/a.bak', '/p/b.bak']],
    ['for f in a; do :; done; rm $f', ['/p/a']],
    ['for f in ..; do rm $f/x; done', ['/x']],
    ['for f in a b; do bash -c true; rm $f; done', ['/p/a', '/p/b']],
    ["python3 - <<'EOF'\ntext = open(p).read()\nEOF\nfor f in a b; do cmd 2>/tmp/err.$f; done", ['/tmp/err.a', '/tmp/err.b']],
    ["for f in a b; do printf '%s' x; rm $f; done", ['/p/a', '/p/b']],
  ])('%s names one target per value', (command, expected) => {
    expect(targets(command)).toEqual(expected);
  });

  it.each([
    'for f in a b; do f=../x; rm $f; done',
    'for f in a b; do f+=x; rm $f; done',
    'for f in a b; do printf -v f x; rm $f; done',
    'for f in a b; do (( f=7 )); rm $f; done',
    'for ((f=0; f<2; f++)); do rm $f; done',
    'for f in /tmp/a; do g; cp x $f; g() { f=x; }; done',
    'for f in a b; do echo $((f=5)); rm $f; done',
    'for f in a b; do a[f=5]=x; rm $f; done',
    'r=read; for f in a b; do $r f; rm $f; done',
    '$r x; for f in a b; do rm $f; done',
    'for f in a b; do for f in *.c; do rm $f; done; done',
    'for f in $(ls); do rm $f; done',
    'for f in *.c; do rm $f; done',
    'for f in "*.c"; do rm $f; done',
    'for f in "a b"; do rm $f; done',
    'for f in a.c; do rm ${f%.c}; done',
    'for f in a; do rm ${f/a/..}; done',
    'for f in a; do rm ${f:-z}; done',
    'for f in a; do rm ${f[0]}; done',
    'for f in a b; do bash -c "rm src/\\$f"; done',
    'for f a b; do rm $f; done',
  ])('%s leaves $f unknown', (command) => {
    expect(targets(command)).toEqual(['? the variable $f']);
  });

  it.each(['HOME', 'TMPDIR', 'TMP'])('a loop over %s leaves it unknown in a script that also rebinds a variable', (name) => {
    expect(targets(`let x=1; for ${name} in a b; do rm $${name}/x; done`)).toEqual([`? the variable $${name}`]);
  });

  it.each(['select', 'let', 'eval', 'source', '.', 'trap', 'alias', 'read', 'mapfile', 'readarray', 'getopts', 'unset', 'wait', 'coproc', 'declare', 'typeset', 'local', 'function'])(
    '%s in a loop body leaves $f unknown',
    (word) => {
      const got = targets(`for f in a b; do ${word} f; rm $f; done`);
      expect([got.includes('? the variable $f'), got.includes('/p/a')]).toEqual([true, false]);
    },
  );

  it.each(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])('[[ 1 %s f=5 ]] leaves $f unknown', (operator) => {
    expect(targets(`for f in a b; do [[ 1 ${operator} f=5 ]]; rm $f; done`)).toEqual(['? the variable $f']);
  });

  it('leaves $f unknown after an eval, which also stays unknown', () => {
    expect(targets('for f in a b; do eval "f=x"; rm $f; done')).toEqual(['? eval runs text CodeRay cannot read', '? the variable $f']);
  });

  it.each(['HOME', 'TMPDIR', 'TMP'])('a loop over %s leaves it unknown', (name) => {
    expect(targets(`for ${name} in a b; do rm $${name}/x; done`)).toEqual([`? the variable $${name}`]);
  });

  it('names at most 32 paths for one word and leaves the variable unknown beyond that', () => {
    const nested = (outer: number, inner: number) => {
      const values = (count: number) => Array.from({ length: count }, (_, i) => `v${i}`).join(' ');
      return `for a in ${values(outer)}; do for b in ${values(inner)}; do rm $a/$b; done; done`;
    };
    expect([targets(nested(4, 8)).length, targets(nested(3, 11))]).toEqual([32, ['? the variable $a']]);
  });
});

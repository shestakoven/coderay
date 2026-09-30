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

  it.each(['source s.sh', '. s.sh', "bash -c -- 'touch x'", 'echo x > ~other/f.ts', "echo x > $'a\\n.ts'", 'echo x > $\'a\\x41.ts\''])('%s has an unresolved target', (command) => {
    expect(writes(command).targets.some((target) => target.unresolved !== null)).toBe(true);
  });

  it('a mktemp variable followed by .. is not temp', () => {
    const got = writes('T=$(mktemp -d); echo x > $T/../../proj/f.ts');
    expect(got.targets.every((target) => !target.temp)).toBe(true);
    expect(got.targets.length).toBe(1);
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
    expect(targets('cd "$DIR" && rm x')).toEqual(['? a relative path after a cd the IDE cannot follow']);
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
    expect(targets('sh -c "$CMD"')).toEqual(['? a shell script the IDE cannot read']);
  });

  it('marks git commands that rewrite the work tree, and no others', () => {
    expect(writes('git checkout main').allTracked).toBe(true);
    expect(writes('git -C sub reset --hard').allTracked).toBe(true);
    expect(writes('git revert HEAD').allTracked).toBe(true);
    expect(writes('git status && git log --oneline && git commit -m "a > b"').allTracked).toBe(false);
  });

  it('leaves find -delete, find -exec rm, xargs rm and eval unresolved', () => {
    expect(targets("find . -name '*.tmp' -delete")).toEqual(['? find deletes or changes the files it finds']);
    expect(targets('find . -exec rm {} \\;')).toEqual(['? find deletes or changes the files it finds']);
    expect(targets('ls | xargs -n 1 rm')).toEqual(['? xargs runs a command that writes files it reads from its input']);
    expect(targets('eval "$X"')).toEqual(['? eval runs text the IDE cannot read']);
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

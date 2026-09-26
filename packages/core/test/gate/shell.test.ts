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
});

import { beforeAll, describe, expect, it } from 'vitest';
import type { MapSymbol } from '@ide/protocol';
import { createCAdapter, createCppAdapter } from '../../src/lang/c-family';
import type { LanguageAdapter } from '../../src/lang/types';

let c: LanguageAdapter;
let cpp: LanguageAdapter;

const lines = (...parts: string[]) => parts.join('\n');
const existing = (...paths: string[]) => (path: string) => paths.includes(path);
const sym = (name: string, kind: MapSymbol['kind'], startLine: number, endLine: number, exported = true) => ({
  name,
  kind,
  startLine,
  endLine,
  exported,
});

const flavors = [
  { name: 'C', file: 'src/x.c', adapter: () => c },
  { name: 'C++', file: 'src/x.cpp', adapter: () => cpp },
];

beforeAll(async () => {
  c = await createCAdapter();
  cpp = await createCppAdapter();
});

describe('C-family adapters: identity', () => {
  it('C adapter reports lang c', () => {
    expect(c.lang).toBe('c');
  });

  it('C++ adapter reports lang cpp', () => {
    expect(cpp.lang).toBe('cpp');
  });

  it('C adapter handles .c files only', () => {
    expect(['a.c', 'src/net/conn.c'].filter((p) => !c.handles(p))).toEqual([]);
    expect(
      ['a.h', 'a.hh', 'a.hpp', 'a.hxx', 'a.cc', 'a.cpp', 'a.cxx', 'a.cs', 'a.py', 'a.c.txt', 'a.c.bak', 'c', 'Makefile'].filter((p) =>
        c.handles(p),
      ),
    ).toEqual([]);
  });

  it('C++ adapter handles headers and C++ sources only', () => {
    expect(
      ['a.h', 'a.hh', 'a.hpp', 'a.hxx', 'a.cc', 'a.cpp', 'a.cxx', 'include/net/conn.h'].filter((p) => !cpp.handles(p)),
    ).toEqual([]);
    expect(
      ['a.c', 'a.cs', 'a.py', 'a.hpp.bak', 'a.cc.txt', 'a.cpp.orig', 'a.hxx.orig', 'a.cxx.txt', 'h', 'Makefile'].filter((p) =>
        cpp.handles(p),
      ),
    ).toEqual([]);
  });
});

describe.each(flavors)('$name imports', ({ file, adapter }) => {
  const importsOf = (source: string) => adapter().parse(file, source).imports;

  it('strips quotes and angle brackets and keeps the order of appearance', () => {
    expect(
      importsOf(lines('#include <stdio.h>', '#include "a/b.h"', '#include <sys/types.h>', '#include "../common/defs.h"')),
    ).toEqual(['stdio.h', 'a/b.h', 'sys/types.h', '../common/defs.h']);
  });

  it('lists a repeated include once, at its first position', () => {
    expect(importsOf(lines('#include "a.h"', '#include <b.h>', '#include "a.h"', '#include <a.h>'))).toEqual(['a.h', 'b.h']);
  });

  it('finds includes nested in conditional blocks', () => {
    expect(
      importsOf(
        lines(
          '#ifdef _WIN32',
          '#include <windows.h>',
          '#else',
          '#include <unistd.h>',
          '#endif',
          '#if defined(USE_TLS) && USE_TLS',
          '#include "tls/ssl.h"',
          '#endif',
        ),
      ),
    ).toEqual(['windows.h', 'unistd.h', 'tls/ssl.h']);
  });

  it('accepts whitespace between # and include', () => {
    expect(importsOf(lines('#  include "tls/ssl.h"', '#\tinclude <x.h>'))).toEqual(['tls/ssl.h', 'x.h']);
  });

  it('ignores includes inside comments', () => {
    expect(importsOf(lines('// #include "old.h"', '/*', '#include <legacy.h>', '*/', '#include "real.h"'))).toEqual(['real.h']);
  });

  it('returns an empty list when the file has no includes', () => {
    expect(importsOf('int x;')).toEqual([]);
  });

  it('does not leave carriage returns in include paths of a CRLF file', () => {
    expect(importsOf(['#include "a.h"', '#include <b.h>', 'int x;'].join('\r\n'))).toEqual(['a.h', 'b.h']);
  });
});

describe.each(flavors)('$name symbols', ({ file, adapter }) => {
  const symbolsOf = (source: string) => adapter().parse(file, source).symbols;

  it('lists a function definition over its whole body', () => {
    expect(symbolsOf(lines('int add(int a, int b) {', '    return a + b;', '}'))).toEqual([sym('add', 'function', 1, 3)]);
  });

  it('marks a static function as not exported even when its brace is on its own line', () => {
    expect(symbolsOf(lines('static int helper(void)', '{', '    return 1;', '}'))).toEqual([
      sym('helper', 'function', 1, 4, false),
    ]);
  });

  it('decides exported by static only, not by inline', () => {
    expect(
      symbolsOf(lines('static inline int fast(int x) { return x; }', 'inline int shared(int x) { return x; }')),
    ).toEqual([sym('fast', 'function', 1, 1, false), sym('shared', 'function', 2, 2)]);
  });

  it('names a pointer-returning function by its declared name', () => {
    expect(
      symbolsOf(
        lines('char *dup(const char *s)', '{', '    return 0;', '}', '', 'char **split(const char *s, char sep) {', '    return 0;', '}'),
      ),
    ).toEqual([sym('dup', 'function', 1, 4), sym('split', 'function', 6, 8)]);
  });

  it('names a function by its own declarator and not by a function-pointer parameter', () => {
    expect(
      symbolsOf(
        lines('void each(int *xs, int n, void (*cb)(int))', '{', '    for (int i = 0; i < n; i++) cb(xs[i]);', '}'),
      ),
    ).toEqual([sym('each', 'function', 1, 4)]);
  });

  it('lists a struct and a union with a body as classes', () => {
    expect(
      symbolsOf(
        lines('struct point {', '    int x;', '    int y;', '};', '', 'union value {', '    int i;', '    float f;', '};'),
      ),
    ).toEqual([sym('point', 'class', 1, 4), sym('value', 'class', 6, 9)]);
  });

  it('lists an enum with a body as one enum and does not list its enumerators', () => {
    expect(symbolsOf(lines('enum color { RED, GREEN, BLUE };', '', 'enum level {', '    LOW,', '    HIGH', '};'))).toEqual([
      sym('color', 'enum', 1, 1),
      sym('level', 'enum', 3, 6),
    ]);
  });

  it('does not list forward declarations of structs and unions', () => {
    expect(symbolsOf(lines('struct S;', 'union U;', '', 'struct S *make(void) { return 0; }'))).toEqual([
      sym('make', 'function', 4, 4),
    ]);
  });

  it('lists only the new name for a typedef of a forward-declared struct', () => {
    expect(symbolsOf(lines('struct S;', 'typedef struct S T;'))).toEqual([sym('T', 'type', 2, 2)]);
  });

  it('lists only the typedef name for a typedef of an anonymous struct', () => {
    expect(symbolsOf(lines('typedef struct {', '    int a;', '} P;'))).toEqual([sym('P', 'type', 1, 3)]);
  });

  it('lists only the typedef name for a typedef of a named struct with a body', () => {
    expect(symbolsOf(lines('typedef struct S {', '    int a;', '} T;'))).toEqual([sym('T', 'type', 1, 3)]);
  });

  it('lists only the typedef name for a typedef of an anonymous enum', () => {
    expect(symbolsOf(lines('typedef enum {', '    M_FAST,', '    M_SLOW,', '} mode_e;'))).toEqual([sym('mode_e', 'type', 1, 4)]);
  });

  it('names a function-pointer typedef and an array typedef by the new type name', () => {
    expect(
      symbolsOf(lines('typedef int (*cmp_fn)(const void *, const void *);', 'typedef char name_t[32];')),
    ).toEqual([sym('cmp_fn', 'type', 1, 1), sym('name_t', 'type', 2, 2)]);
  });

  it('lists one variable per declarator, all sharing the declaration range', () => {
    expect(symbolsOf(lines('int a, b;', 'int *p, q[4], r = 1;'))).toEqual([
      sym('a', 'variable', 1, 1),
      sym('b', 'variable', 1, 1),
      sym('p', 'variable', 2, 2),
      sym('q', 'variable', 2, 2),
      sym('r', 'variable', 2, 2),
    ]);
  });

  it('marks a static variable as not exported', () => {
    expect(symbolsOf(lines('static int counter = 0;', 'int visible = 1;'))).toEqual([
      sym('counter', 'variable', 1, 1, false),
      sym('visible', 'variable', 2, 2),
    ]);
  });

  it('spans a multi-line initializer up to the closing semicolon', () => {
    expect(symbolsOf(lines('static const char *names[] = {', '    "alpha",', '    "beta",', '};'))).toEqual([
      sym('names', 'variable', 1, 4, false),
    ]);
  });

  it('lists a variable of struct type as a variable and not as a class', () => {
    expect(symbolsOf(lines('struct node *head;', 'struct node *tail = 0;'))).toEqual([
      sym('head', 'variable', 1, 1),
      sym('tail', 'variable', 2, 2),
    ]);
  });

  it('does not list anything declared inside a function body', () => {
    expect(
      symbolsOf(
        lines(
          'int run(void)',
          '{',
          '    static int calls = 0;',
          '    struct local { int v; } l;',
          '    int helper = 1;',
          '    return calls + helper;',
          '}',
        ),
      ),
    ).toEqual([sym('run', 'function', 1, 7)]);
  });

  it('does not list macros', () => {
    expect(
      symbolsOf(lines('#define MAX(a, b) ((a) > (b) ? (a) : (b))', '#define LIMIT 10', 'int limit(void) { return LIMIT; }')),
    ).toEqual([sym('limit', 'function', 3, 3)]);
  });

  it('looks through #if/#ifdef/#else blocks and keeps source order', () => {
    expect(
      symbolsOf(
        lines(
          '#ifdef _WIN32',
          'static int win_only(void) { return 1; }',
          '#else',
          'int posix_only(void) { return 2; }',
          '#endif',
          '',
          '#if USE_FAST',
          'int speed = 3;',
          '#endif',
        ),
      ),
    ).toEqual([sym('win_only', 'function', 2, 2, false), sym('posix_only', 'function', 4, 4), sym('speed', 'variable', 8, 8)]);
  });

  it('looks through nested conditional blocks', () => {
    expect(symbolsOf(lines('#ifdef A', '#ifdef B', 'int ab;', '#endif', 'int a_only;', '#endif'))).toEqual([
      sym('ab', 'variable', 3, 3),
      sym('a_only', 'variable', 5, 5),
    ]);
  });

  it('looks through an include guard without listing its macro', () => {
    expect(symbolsOf(lines('#ifndef ONCE_H', '#define ONCE_H', 'int once(void) { return 1; }', '#endif'))).toEqual([
      sym('once', 'function', 3, 3),
    ]);
  });

  it('reports the same ranges for a CRLF file', () => {
    const source = ['#include "a.h"', 'int add(int a, int b)', '{', '    return a + b;', '}'].join('\r\n');
    expect(symbolsOf(source)).toEqual([sym('add', 'function', 2, 5)]);
  });

  it('keeps names intact when non-ASCII text precedes them', () => {
    expect(
      symbolsOf(lines('// привет, мир', 'const char *greeting = "здравствуй";', 'int after(void) { return 1; }')),
    ).toEqual([sym('greeting', 'variable', 2, 2), sym('after', 'function', 3, 3)]);
  });

  it('returns an empty result for an empty file', () => {
    expect(adapter().parse(file, '')).toEqual({ imports: [], symbols: [], parseError: false });
  });
});

describe('C adapter on a realistic source file', () => {
  const source = lines(
    '#include <stdlib.h>',
    '#include <string.h>',
    '#include "conn.h"',
    '#include "util/log.h"',
    '',
    '#define MAX_CONNS 64',
    '',
    'struct pool {',
    '    conn_t *items[MAX_CONNS];',
    '    size_t used;',
    '};',
    '',
    'static struct pool g_pool;',
    'int conn_errors = 0;',
    '',
    'static void pool_reset(void)',
    '{',
    '    memset(&g_pool, 0, sizeof g_pool);',
    '}',
    '',
    'conn_t *conn_open(const char *host, int port)',
    '{',
    '    conn_t *c = calloc(1, sizeof *c);',
    '    if (!c) {',
    '        return NULL;',
    '    }',
    '    return c;',
    '}',
    '',
    'void conn_close(conn_t *c)',
    '{',
    '    free(c);',
    '}',
    '',
  );

  it('extracts imports, symbols in source order and no parse error', () => {
    expect(c.parse('src/net/conn.c', source)).toEqual({
      imports: ['stdlib.h', 'string.h', 'conn.h', 'util/log.h'],
      symbols: [
        sym('pool', 'class', 8, 11),
        sym('g_pool', 'variable', 13, 13, false),
        sym('conn_errors', 'variable', 14, 14),
        sym('pool_reset', 'function', 16, 19, false),
        sym('conn_open', 'function', 21, 28),
        sym('conn_close', 'function', 30, 33),
      ],
      parseError: false,
    });
  });
});

describe('C++ adapter symbols', () => {
  const symbolsOf = (source: string, path = 'src/x.cpp') => cpp.parse(path, source).symbols;

  it('lists a class inside a namespace by its simple name and not its members', () => {
    expect(
      symbolsOf(
        lines(
          'namespace app {',
          '',
          'class Widget : public Base {',
          'public:',
          '    Widget();',
          '    void draw() const;',
          '    int size() const { return size_; }',
          '    struct Inner { int v; };',
          'private:',
          '    int size_ = 0;',
          '};',
          '',
          '}  // namespace app',
        ),
        'include/app/widget.hpp',
      ),
    ).toEqual([sym('Widget', 'class', 3, 11)]);
  });

  it('looks through nested namespaces', () => {
    expect(
      symbolsOf(
        lines('namespace a {', 'namespace b {', 'int deep(int x) { return x; }', '}', 'int shallow = 1;', '}'),
      ),
    ).toEqual([sym('deep', 'function', 3, 3), sym('shallow', 'variable', 5, 5)]);
  });

  it('looks through a C++17 nested namespace definition', () => {
    expect(symbolsOf(lines('namespace x::y::z {', 'struct Pt { int v; };', '}'))).toEqual([sym('Pt', 'class', 2, 2)]);
  });

  it('names an out-of-line method by its qualified name, without the enclosing namespace', () => {
    expect(
      symbolsOf(
        lines(
          'namespace app {',
          '',
          'void Widget::draw() const',
          '{',
          '    render(size_);',
          '}',
          '',
          'int Widget::size() const { return size_; }',
          '',
          '}',
        ),
      ),
    ).toEqual([sym('Widget::draw', 'function', 3, 6), sym('Widget::size', 'function', 8, 8)]);
  });

  it('names an out-of-line constructor and destructor by their qualified names', () => {
    expect(symbolsOf(lines('Widget::Widget() : size_(0) {}', '', 'Widget::~Widget()', '{', '}'))).toEqual([
      sym('Widget::Widget', 'function', 1, 1),
      sym('Widget::~Widget', 'function', 3, 5),
    ]);
  });

  it('includes the template line in the range of a class template', () => {
    expect(symbolsOf(lines('template <typename T>', 'class Box {', 'public:', '    T value;', '};'))).toEqual([
      sym('Box', 'class', 1, 5),
    ]);
  });

  it('includes the template line in the range of a function template', () => {
    expect(
      symbolsOf(lines('template <typename T>', 'T max_of(T a, T b)', '{', '    return a > b ? a : b;', '}')),
    ).toEqual([sym('max_of', 'function', 1, 5)]);
  });

  it('lists a class template written on a single line', () => {
    expect(symbolsOf('template <typename T, typename U> struct Pair { T first; U second; };')).toEqual([
      sym('Pair', 'class', 1, 1),
    ]);
  });

  it('lists an alias template as a type over both lines', () => {
    expect(symbolsOf(lines('template <typename T>', 'using Vec = std::vector<T>;'))).toEqual([sym('Vec', 'type', 1, 2)]);
  });

  it('lists an enum class with a body as an enum', () => {
    expect(symbolsOf(lines('enum class Mode : int {', '    Fast,', '    Slow,', '};', '', 'enum Legacy { L_A, L_B };'))).toEqual([
      sym('Mode', 'enum', 1, 4),
      sym('Legacy', 'enum', 6, 6),
    ]);
  });

  it('does not list forward declarations of classes, structs and enum classes', () => {
    expect(
      symbolsOf(
        lines('class Fwd;', 'struct Opaque;', 'namespace n { class Inner; }', 'enum class Mode : int;', 'class Real { int v; };'),
        'include/fwd.hpp',
      ),
    ).toEqual([sym('Real', 'class', 5, 5)]);
  });

  it('lists using-aliases and typedefs as types', () => {
    expect(
      symbolsOf(lines('using Id = int;', 'using Handler = void (*)(int);', 'typedef unsigned long ulong_t;')),
    ).toEqual([sym('Id', 'type', 1, 1), sym('Handler', 'type', 2, 2), sym('ulong_t', 'type', 3, 3)]);
  });

  it('does not list using-declarations and using-directives', () => {
    expect(symbolsOf(lines('using std::string;', 'using namespace std;', 'int after = 1;'))).toEqual([
      sym('after', 'variable', 3, 3),
    ]);
  });

  it('looks through extern "C" blocks in a header, listing prototypes, structs and typedefs', () => {
    expect(
      symbolsOf(
        lines(
          'extern "C" {',
          '',
          'int c_api(int x);',
          'struct handle { int fd; };',
          'typedef struct handle handle_t;',
          '',
          '}',
        ),
        'include/c_api.h',
      ),
    ).toEqual([sym('c_api', 'function', 3, 3), sym('handle', 'class', 4, 4), sym('handle_t', 'type', 5, 5)]);
  });

  it('looks through an extern "C" block in a source file, where prototypes stay ignored', () => {
    expect(symbolsOf(lines('extern "C" {', 'int c_api(int x);', 'int c_impl(int x) { return x; }', '}'))).toEqual([
      sym('c_impl', 'function', 3, 3),
    ]);
  });

  it('does not list classes, lambdas or statics declared inside a function body', () => {
    expect(
      symbolsOf(
        lines(
          'int run()',
          '{',
          '    struct Local { int v; };',
          '    auto f = [](int x) { return x; };',
          '    static int calls = 0;',
          '    return f(calls);',
          '}',
        ),
      ),
    ).toEqual([sym('run', 'function', 1, 7)]);
  });

  it('lists constexpr, static const and templated-type variables', () => {
    expect(symbolsOf(lines('constexpr int kLimit = 5;', 'static const int kMax = 10;', 'std::vector<int> items;'))).toEqual([
      sym('kLimit', 'variable', 1, 1),
      sym('kMax', 'variable', 2, 2, false),
      sym('items', 'variable', 3, 3),
    ]);
  });
});

describe('C++ adapter on headers', () => {
  it.each(['include/a.h', 'include/a.hh', 'include/a.hpp', 'include/a.hxx'])('lists function prototypes in %s', (path) => {
    const { symbols } = cpp.parse(path, lines('int g(int x);', 'void h(void);', 'char *name_of(int id);'));
    expect(symbols).toEqual([sym('g', 'function', 1, 1), sym('h', 'function', 2, 2), sym('name_of', 'function', 3, 3)]);
  });

  it.each(['a.c', 'a.cc', 'a.cpp', 'a.cxx'])('ignores function prototypes in %s', (path) => {
    const adapter = path === 'a.c' ? c : cpp;
    const { symbols } = adapter.parse(path, lines('int g(int x);', 'int h(int x) { return g(x); }'));
    expect(symbols).toEqual([sym('h', 'function', 2, 2)]);
  });

  it('spans a multi-line prototype and tells a prototype from a variable', () => {
    expect(
      cpp.parse('include/net.h', lines('int connect(', '    const char *host,', '    int port);', 'int counter;')).symbols,
    ).toEqual([sym('connect', 'function', 1, 3), sym('counter', 'variable', 4, 4)]);
  });

  it('lists prototypes declared inside a namespace', () => {
    expect(
      cpp.parse('include/net.hpp', lines('namespace net {', 'int connect(const char *host, int port);', 'void close(int fd);', '}')).symbols,
    ).toEqual([sym('connect', 'function', 2, 2), sym('close', 'function', 3, 3)]);
  });

  it('lists the contents of a classic C header between include-guard directives', () => {
    const source = lines(
      '#ifndef NET_CONN_H',
      '#define NET_CONN_H',
      '',
      '#include <stddef.h>',
      '#include "net/types.h"',
      '',
      'typedef struct conn conn_t;',
      '',
      'struct conn {',
      '    int fd;',
      '    size_t len;',
      '};',
      '',
      'enum conn_state {',
      '    CONN_IDLE,',
      '    CONN_OPEN,',
      '};',
      '',
      'conn_t *conn_open(const char *host, int port);',
      'void conn_close(conn_t *c);',
      '',
      '#endif /* NET_CONN_H */',
      '',
    );
    expect(cpp.parse('include/net/conn.h', source)).toEqual({
      imports: ['stddef.h', 'net/types.h'],
      symbols: [
        sym('conn_t', 'type', 7, 7),
        sym('conn', 'class', 9, 12),
        sym('conn_state', 'enum', 14, 17),
        sym('conn_open', 'function', 19, 19),
        sym('conn_close', 'function', 20, 20),
      ],
      parseError: false,
    });
  });

  it('looks through the conventional extern "C" guard split across two #ifdef __cplusplus blocks', () => {
    const source = lines(
      '#ifndef LIB_H',
      '#define LIB_H',
      '',
      '#ifdef __cplusplus',
      'extern "C" {',
      '#endif',
      '',
      'int lib_init(void);',
      'void lib_exit(void);',
      '',
      '#ifdef __cplusplus',
      '}',
      '#endif',
      '',
      '#endif',
      '',
    );
    expect(cpp.parse('include/lib.h', source).symbols).toEqual([
      sym('lib_init', 'function', 8, 8),
      sym('lib_exit', 'function', 9, 9),
    ]);
  });

  it('hands a .h file with a C++ class in a namespace and an include guard to the C++ adapter', () => {
    const source = lines(
      '#ifndef WIDGET_H',
      '#define WIDGET_H',
      '',
      'namespace ui {',
      '',
      'class Widget {',
      'public:',
      '    virtual ~Widget() = default;',
      '    virtual void draw() = 0;',
      '};',
      '',
      '}  // namespace ui',
      '',
      '#endif',
      '',
    );
    expect(cpp.handles('include/ui/widget.h')).toBe(true);
    expect(cpp.parse('include/ui/widget.h', source).symbols).toEqual([sym('Widget', 'class', 6, 10)]);
  });
});

describe.each(flavors)('$name parse errors and provides', ({ file, adapter }) => {
  it('flags a syntax error without throwing', () => {
    expect(() => adapter().parse(file, 'int f( {')).not.toThrow();
    expect(adapter().parse(file, 'int f( {').parseError).toBe(true);
  });

  it('does not flag valid code', () => {
    expect(adapter().parse(file, lines('#include <stdio.h>', 'int f(void) { return 0; }')).parseError).toBe(false);
  });

  it('leaves provides undefined', () => {
    const parsed = adapter().parse(file, lines('#include "a.h"', 'int f(void) { return 0; }'));
    expect(parsed.provides).toBeUndefined();
  });
});

describe('C++ adapter parse errors', () => {
  it('flags an unterminated class without throwing', () => {
    expect(() => cpp.parse('src/x.cpp', 'class Widget {')).not.toThrow();
    expect(cpp.parse('src/x.cpp', 'class Widget {').parseError).toBe(true);
  });
});

describe.each(flavors)('$name resolve', ({ adapter }) => {
  it('prefers a file next to the includer over a match in a farther directory', () => {
    const exists = existing('src/net/util.h', 'src/util.h', 'include/util.h', 'util.h');
    expect(adapter().resolve('src/net/conn.c', 'util.h', exists)).toBe('src/net/util.h');
  });

  it('finds a header through an ancestor directory of the includer', () => {
    const exists = existing('src/util/log.h');
    expect(adapter().resolve('src/net/conn.c', 'util/log.h', exists)).toBe('src/util/log.h');
  });

  it('finds a header under the include directory of the project root', () => {
    const exists = existing('include/foo/b.h');
    expect(adapter().resolve('src/app/main.c', 'foo/b.h', exists)).toBe('include/foo/b.h');
  });

  it('resolves a parent-relative include against the includer directory', () => {
    const exists = existing('src/common.h');
    expect(adapter().resolve('src/net/x.c', '../common.h', exists)).toBe('src/common.h');
  });

  it('resolves a parent-relative include that lands in the project root', () => {
    const exists = existing('common.h');
    expect(adapter().resolve('src/x.c', '../common.h', exists)).toBe('common.h');
  });

  it('normalizes a ./ prefix in the specifier', () => {
    const exists = existing('src/local.h');
    expect(adapter().resolve('src/a.c', './local.h', exists)).toBe('src/local.h');
  });

  it('finds a header under the include directory of a nested project', () => {
    const exists = existing('lib/include/lib_api/x.h');
    expect(adapter().resolve('lib/src/a.c', 'lib_api/x.h', exists)).toBe('lib/include/lib_api/x.h');
  });

  it('prefers the include directory of a nearer ancestor over a plain match at a farther ancestor', () => {
    const exists = existing('lib/include/x/y.h', 'x/y.h');
    expect(adapter().resolve('lib/src/a.c', 'x/y.h', exists)).toBe('lib/include/x/y.h');
  });

  it.each([
    { files: ['a/h.h', 'include/a/h.h', 'src/a/h.h'], expected: 'a/h.h' },
    { files: ['include/a/h.h', 'src/a/h.h'], expected: 'include/a/h.h' },
    { files: ['src/a/h.h'], expected: 'src/a/h.h' },
  ])('at one ancestor tries the bare path, then include, then src: $expected', ({ files, expected }) => {
    expect(adapter().resolve('main.c', 'a/h.h', existing(...files))).toBe(expected);
  });

  it('applies the src prefix at every ancestor, not only the root', () => {
    const exists = existing('app/src/m/a.h');
    expect(adapter().resolve('app/x.c', 'm/a.h', exists)).toBe('app/src/m/a.h');
  });

  it('does not search subdirectories of the includer directory', () => {
    const exists = existing('src/sub/foo.h');
    expect(adapter().resolve('src/a.c', 'foo.h', exists)).toBeNull();
  });

  it('ignores candidates that climb above the project root', () => {
    const exists = (path: string) => path.startsWith('..');
    expect(adapter().resolve('a.c', '../outside.h', exists)).toBeNull();
  });

  it('returns null for a system header', () => {
    const exists = existing('src/net/conn.c', 'src/util/log.h', 'include/foo.h');
    expect(adapter().resolve('src/net/conn.c', 'stdio.h', exists)).toBeNull();
    expect(adapter().resolve('src/net/conn.c', 'sys/types.h', exists)).toBeNull();
  });

  it('returns null when nothing exists', () => {
    expect(adapter().resolve('src/net/conn.c', 'util/log.h', existing())).toBeNull();
  });
});

describe('C++ adapter: C-grammar fallback for .h files', () => {
  const pyApi = lines(
    'PyAPI_FUNC(int) Py_IsInitialized(void);',
    'PyAPI_FUNC(void) Py_Finalize(void);',
    'PyAPI_DATA(int) Py_DebugFlag;',
    '',
  );
  const pyApiSymbols = [
    sym('Py_IsInitialized', 'function', 1, 1),
    sym('Py_Finalize', 'function', 2, 2),
    sym('Py_DebugFlag', 'variable', 3, 3),
  ];

  it('recovers macro-decorated C prototypes and data in a .h file', () => {
    expect(cpp.parse('a.h', pyApi)).toEqual({ imports: [], symbols: pyApiSymbols, parseError: false });
  });

  it('recovers the same symbols for a .h file in a nested directory', () => {
    expect(cpp.parse('Include/pylifecycle.h', pyApi).symbols).toEqual(pyApiSymbols);
  });

  it('keeps the imports of the recovered file', () => {
    const source = lines('#include "pyport.h"', pyApi);
    expect(cpp.parse('a.h', source)).toEqual({
      imports: ['pyport.h'],
      symbols: [
        sym('Py_IsInitialized', 'function', 2, 2),
        sym('Py_Finalize', 'function', 3, 3),
        sym('Py_DebugFlag', 'variable', 4, 4),
      ],
      parseError: false,
    });
  });

  it('returns the C result for a clean C parse even when both grammars find the same number of symbols', () => {
    const source = lines('PyAPI_FUNC(int) Py_IsInitialized(void);', 'PyAPI_FUNC(void) Py_Finalize(void);', '');
    const parsed = cpp.parse('a.h', source);
    expect(parsed).toEqual({
      imports: [],
      symbols: [sym('Py_IsInitialized', 'function', 1, 1), sym('Py_Finalize', 'function', 2, 2)],
      parseError: false,
    });
    expect(parsed).not.toEqual(cpp.parse('a.hpp', source));
  });

  it.each([
    lines('namespace n {', 'class Widget {', '  void draw();', '};', '}', 'class Broken {', ''),
    lines('int ok;', 'class Broken {', ''),
  ])('keeps the C++ result when the C grammar also reports a parse error', (source) => {
    const parsed = cpp.parse('w.h', source);
    expect(parsed.parseError).toBe(true);
    expect(parsed).toEqual(cpp.parse('w.hpp', source));
  });

  it('recovers a mix of typedef, macro-decorated prototype and static inline function', () => {
    const source = lines(
      'typedef struct _object PyObject;',
      'PyAPI_FUNC(PyObject *) PyObject_Repr(PyObject *);',
      'static inline int f(int x) { return x; }',
      '',
    );
    expect(cpp.parse('a.h', source)).toEqual({
      imports: [],
      symbols: [sym('PyObject', 'type', 1, 1), sym('PyObject_Repr', 'function', 2, 2), sym('f', 'function', 3, 3, false)],
      parseError: false,
    });
  });

  it.each(['a.hpp', 'a.hh', 'a.hxx', 'a.cc', 'a.cpp', 'a.cxx'])('does not fall back to the C grammar for %s', (path) => {
    expect(cpp.parse(path, pyApi).symbols).not.toEqual(pyApiSymbols);
  });

  it('keeps the C++ result when the C grammar finds fewer symbols', () => {
    const source = lines('namespace n {', 'class Widget {', '  void draw();', '};', '}', 'class Broken {', '');
    const parsed = cpp.parse('w.h', source);
    expect(parsed.parseError).toBe(true);
    expect(parsed.symbols).toContainEqual(sym('Widget', 'class', 2, 4));
  });

  it('leaves a clean C++ header untouched', () => {
    expect(cpp.parse('a.h', 'class A {};\n')).toEqual({
      imports: [],
      symbols: [sym('A', 'class', 1, 1)],
      parseError: false,
    });
  });
});

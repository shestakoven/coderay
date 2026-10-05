import { beforeAll, describe, expect, it } from 'vitest';
import { createCSharpAdapter } from '../../src/lang/csharp';
import type { LanguageAdapter } from '../../src/lang/types';

let adapter: LanguageAdapter;
const parse = (...lines: string[]) => adapter.parse('src/File.cs', lines.join('\n'));
const providersOf = (table: Record<string, string[]>) => (name: string) => table[name] ?? [];
const resolveAll = (specifier: string, table: Record<string, string[]>): string[] => {
  if (!adapter.resolveAll) throw new Error('the C# adapter has no resolveAll');
  return adapter.resolveAll(specifier, providersOf(table));
};

beforeAll(async () => {
  adapter = await createCSharpAdapter();
});

describe('C# adapter', () => {
  it('is the csharp adapter and handles .cs files only', () => {
    expect(adapter.lang).toBe('csharp');
    expect(['a.cs', 'src/Models/User.cs'].filter((p) => !adapter.handles(p))).toEqual([]);
    expect(['a.csproj', 'a.csx', 'a.c', 'a.cpp', 'a.ts', 'a.cs.bak', 'cs'].filter((p) => adapter.handles(p))).toEqual([]);
  });

  describe('imports', () => {
    it('names the namespace of a using directive', () => {
      expect(parse('using System;').imports).toEqual(['System']);
    });

    it('keeps the full dotted namespace', () => {
      expect(parse('using System.Collections.Generic;').imports).toEqual(['System.Collections.Generic']);
    });

    it('lists usings in source order without sorting them', () => {
      expect(parse('using Zeta;', 'using Alpha.Beta;', 'using Mid;').imports).toEqual(['Zeta', 'Alpha.Beta', 'Mid']);
    });

    it('de-duplicates repeated usings and keeps the first position', () => {
      expect(parse('using A;', 'using B;', 'using A;', 'using C;', 'using B;').imports).toEqual(['A', 'B', 'C']);
    });

    it('treats a global using like a plain using', () => {
      expect(parse('global using X.Y;').imports).toEqual(['X.Y']);
    });

    it('drops the type segment of a using static', () => {
      expect(parse('using static System.Math;').imports).toEqual(['System']);
    });

    it('drops only the last segment of a deeper using static', () => {
      expect(parse('using static Shop.Models.Money;').imports).toEqual(['Shop.Models']);
    });

    it('drops the type segment of a global using static', () => {
      expect(parse('global using static Shop.Models.Money;').imports).toEqual(['Shop.Models']);
    });

    it('gives one import for a plain using and a using static of the same namespace', () => {
      expect(parse('using System;', 'using static System.Math;').imports).toEqual(['System']);
    });

    it('imports the target of an alias, not the alias name', () => {
      expect(parse('using J = Newtonsoft.Json;').imports).toEqual(['Newtonsoft.Json']);
    });

    it('imports a single-segment alias target', () => {
      expect(parse('using Sys = System;').imports).toEqual(['System']);
    });

    it('keeps the type segment when an alias names a type', () => {
      expect(parse('using Dto = MyApp.Models.UserDto;').imports).toEqual(['MyApp.Models.UserDto']);
    });

    it('gives one import for a plain using and an alias of the same namespace', () => {
      expect(parse('using A.B;', 'using J = A.B;').imports).toEqual(['A.B']);
    });

    it('does not treat a using statement as an import', () => {
      const { imports } = parse(
        'using System;',
        'class Worker',
        '{',
        '    void Run(string text)',
        '    {',
        '        using (var reader = new Reader(text))',
        '        {',
        '        }',
        '    }',
        '}',
      );
      expect(imports).toEqual(['System']);
    });

    it('does not treat using declarations as imports', () => {
      const { imports } = parse(
        'using System;',
        'class Worker',
        '{',
        '    async void Run()',
        '    {',
        '        using var reader = Open();',
        '        await using var conn = Connect();',
        '    }',
        '}',
      );
      expect(imports).toEqual(['System']);
    });

    it('counts usings inside a block namespace', () => {
      expect(parse('namespace Shop', '{', '    using System.Linq;', '    class A { }', '}').imports).toEqual(['System.Linq']);
    });

    it('counts usings declared after a file-scoped namespace', () => {
      expect(parse('namespace Shop;', 'using System.Text;', 'class A { }').imports).toEqual(['System.Text']);
    });

    it('lists a top-level using before the usings inside a namespace and de-duplicates across them', () => {
      const { imports } = parse(
        'using System;',
        'namespace Shop',
        '{',
        '    using System;',
        '    using System.Linq;',
        '}',
      );
      expect(imports).toEqual(['System', 'System.Linq']);
    });

    it('is empty for a file without usings', () => {
      expect(parse('class A { }').imports).toEqual([]);
    });

    it('ignores using and namespace text in comments and string literals', () => {
      const parsed = parse(
        '// using Fake.Comment;',
        '/* namespace Hidden { } */',
        'class A',
        '{',
        '    string s = "using Fake.Text; namespace Fake.Ns;";',
        '}',
      );
      expect({ imports: parsed.imports, provides: parsed.provides }).toEqual({ imports: [], provides: [] });
    });
  });

  describe('provides', () => {
    it('names the full dotted namespace of a block namespace and nothing shorter', () => {
      expect(parse('namespace A.B', '{', '}').provides).toEqual(['A.B']);
    });

    it('names a single-segment namespace', () => {
      expect(parse('namespace Shop', '{', '}').provides).toEqual(['Shop']);
    });

    it('names a file-scoped namespace', () => {
      expect(parse('namespace A.B;', '', 'class C { }').provides).toEqual(['A.B']);
    });

    it('qualifies a nested namespace with its parent and keeps the parent', () => {
      expect(parse('namespace A { namespace B { } }').provides).toEqual(['A', 'A.B']);
    });

    it('qualifies a dotted namespace nested in another', () => {
      expect(parse('namespace A { namespace B.C { } }').provides).toEqual(['A', 'A.B.C']);
    });

    it('qualifies namespaces nested three levels deep', () => {
      expect(parse('namespace A { namespace B { namespace C { } } }').provides).toEqual(['A', 'A.B', 'A.B.C']);
    });

    it('lists namespaces in order of appearance, a parent before its children and not sorted', () => {
      const { provides } = parse(
        'namespace Zeta',
        '{',
        '    namespace B { }',
        '    namespace C { }',
        '}',
        'namespace Alpha { }',
      );
      expect(provides).toEqual(['Zeta', 'Zeta.B', 'Zeta.C', 'Alpha']);
    });

    it('de-duplicates a namespace declared twice', () => {
      expect(parse('namespace A { }', 'namespace A { }').provides).toEqual(['A']);
    });

    it('de-duplicates the same name reached through a dotted and a nested declaration', () => {
      expect(parse('namespace A.B { }', 'namespace A { namespace B { } }').provides).toEqual(['A.B', 'A']);
    });

    it('is empty for a file without a namespace', () => {
      expect(parse('using A.B;', 'class C { }').provides).toEqual([]);
    });
  });

  describe('symbols', () => {
    it('lists a class with the range of its whole declaration', () => {
      const { symbols } = parse(
        'namespace Shop;',
        '',
        'public class User',
        '{',
        '    public int Id { get; set; }',
        '}',
      );
      expect(symbols).toEqual([{ name: 'User', kind: 'class', startLine: 3, endLine: 6, exported: true }]);
    });

    it('lists a positional record as one line and a record with a body to its closing brace, both as classes', () => {
      const { symbols } = parse(
        'public record Person(string Name, int Age);',
        '',
        'public record Order',
        '{',
        '    public int Id { get; init; }',
        '}',
      );
      expect(symbols).toEqual([
        { name: 'Person', kind: 'class', startLine: 1, endLine: 1, exported: true },
        { name: 'Order', kind: 'class', startLine: 3, endLine: 6, exported: true },
      ]);
    });

    it('lists structs as classes', () => {
      const { symbols } = parse(
        'public struct Point',
        '{',
        '    public int X;',
        '}',
        '',
        'public readonly struct Id { }',
      );
      expect(symbols).toEqual([
        { name: 'Point', kind: 'class', startLine: 1, endLine: 4, exported: true },
        { name: 'Id', kind: 'class', startLine: 6, endLine: 6, exported: true },
      ]);
    });

    it('lists record structs and record classes as classes', () => {
      const { symbols } = parse(
        'public record struct Pair(int A, int B);',
        'public readonly record struct Money(decimal Amount);',
        'public record class Tag(string Value);',
      );
      expect(symbols).toEqual([
        { name: 'Pair', kind: 'class', startLine: 1, endLine: 1, exported: true },
        { name: 'Money', kind: 'class', startLine: 2, endLine: 2, exported: true },
        { name: 'Tag', kind: 'class', startLine: 3, endLine: 3, exported: true },
      ]);
    });

    it('lists an interface under its plain name', () => {
      const { symbols } = parse(
        'public interface IRepo<T>',
        '{',
        '    T Get(int id);',
        '    void Save(T item);',
        '}',
      );
      expect(symbols).toEqual([{ name: 'IRepo', kind: 'interface', startLine: 1, endLine: 5, exported: true }]);
    });

    it('lists enums, including one with a base type', () => {
      const { symbols } = parse(
        'public enum Color',
        '{',
        '    Red,',
        '    Green,',
        '}',
        '',
        'enum Flags : byte { None = 0, Some = 1 }',
      );
      expect(symbols).toEqual([
        { name: 'Color', kind: 'enum', startLine: 1, endLine: 5, exported: true },
        { name: 'Flags', kind: 'enum', startLine: 7, endLine: 7, exported: true },
      ]);
    });

    it('lists delegates as types, a generic one under its plain name', () => {
      const { symbols } = parse(
        'public delegate void Handler(int code);',
        '',
        'public delegate TResult Convert<T, TResult>(T arg);',
      );
      expect(symbols).toEqual([
        { name: 'Handler', kind: 'type', startLine: 1, endLine: 1, exported: true },
        { name: 'Convert', kind: 'type', startLine: 3, endLine: 3, exported: true },
      ]);
    });

    it('ends a delegate at its semicolon after a wrapped constraint clause', () => {
      const { symbols } = parse(
        'public delegate void Visit<T>(T node)',
        '    where T : class;',
      );
      expect(symbols).toEqual([{ name: 'Visit', kind: 'type', startLine: 1, endLine: 2, exported: true }]);
    });

    it('lists generic types under their plain name and spans their constraint clauses', () => {
      const { symbols } = parse(
        'public class Repo<T>',
        '    where T : class',
        '{',
        '}',
        '',
        'public record Box<T>(T Value);',
        '',
        'public struct Cache<TKey, TValue> { }',
      );
      expect(symbols).toEqual([
        { name: 'Repo', kind: 'class', startLine: 1, endLine: 4, exported: true },
        { name: 'Box', kind: 'class', startLine: 6, endLine: 6, exported: true },
        { name: 'Cache', kind: 'class', startLine: 8, endLine: 8, exported: true },
      ]);
    });

    it('keeps the class kind and name whatever the modifiers', () => {
      const { symbols } = parse(
        'public abstract class Shape { }',
        'public static class Util { }',
        'public sealed partial class Widget { }',
        'internal sealed class Impl { }',
      );
      expect(symbols).toEqual([
        { name: 'Shape', kind: 'class', startLine: 1, endLine: 1, exported: true },
        { name: 'Util', kind: 'class', startLine: 2, endLine: 2, exported: true },
        { name: 'Widget', kind: 'class', startLine: 3, endLine: 3, exported: true },
        { name: 'Impl', kind: 'class', startLine: 4, endLine: 4, exported: true },
      ]);
    });

    it('marks a type with the file modifier as not exported and its neighbours as exported', () => {
      const { symbols } = parse(
        'namespace Shop;',
        '',
        'file class Hidden',
        '{',
        '}',
        '',
        'public class Visible { }',
        '',
        'internal class Plain { }',
      );
      expect(symbols).toEqual([
        { name: 'Hidden', kind: 'class', startLine: 3, endLine: 5, exported: false },
        { name: 'Visible', kind: 'class', startLine: 7, endLine: 7, exported: true },
        { name: 'Plain', kind: 'class', startLine: 9, endLine: 9, exported: true },
      ]);
    });

    it('marks every kind of type with the file modifier as not exported', () => {
      const { symbols } = parse(
        'file interface IHidden { }',
        'file enum HiddenMode { A }',
        'file record HiddenRec(int X);',
        'file struct HiddenStruct { }',
        'file static class HiddenUtil { }',
        'file delegate void HiddenCb();',
      );
      expect(symbols).toEqual([
        { name: 'IHidden', kind: 'interface', startLine: 1, endLine: 1, exported: false },
        { name: 'HiddenMode', kind: 'enum', startLine: 2, endLine: 2, exported: false },
        { name: 'HiddenRec', kind: 'class', startLine: 3, endLine: 3, exported: false },
        { name: 'HiddenStruct', kind: 'class', startLine: 4, endLine: 4, exported: false },
        { name: 'HiddenUtil', kind: 'class', startLine: 5, endLine: 5, exported: false },
        { name: 'HiddenCb', kind: 'type', startLine: 6, endLine: 6, exported: false },
      ]);
    });

    it('does not mistake a name containing "file" for the file modifier', () => {
      const { symbols } = parse(
        'public class FileCache { }',
        'class Profile { }',
        'public interface IFileSystem { }',
      );
      expect(symbols.map((s) => [s.name, s.exported])).toEqual([
        ['FileCache', true],
        ['Profile', true],
        ['IFileSystem', true],
      ]);
    });

    it('starts the range at the first attribute line', () => {
      const { symbols } = parse(
        'using System;',
        '',
        '[Serializable]',
        '[Obsolete("use Modern")]',
        'public class Legacy',
        '{',
        '}',
      );
      expect(symbols).toEqual([{ name: 'Legacy', kind: 'class', startLine: 3, endLine: 7, exported: true }]);
    });

    it('starts an enum range at its attribute line', () => {
      const { symbols } = parse(
        '[Flags]',
        'public enum Perm',
        '{',
        '    None = 0,',
        '}',
      );
      expect(symbols).toEqual([{ name: 'Perm', kind: 'enum', startLine: 1, endLine: 5, exported: true }]);
    });

    it('does not extend the range up to a doc comment above the attributes', () => {
      const { symbols } = parse(
        '/// <summary>A user.</summary>',
        '// plain comment',
        '[Serializable]',
        'public class User { }',
      );
      expect(symbols).toEqual([{ name: 'User', kind: 'class', startLine: 3, endLine: 4, exported: true }]);
    });

    it('does not list members or nested types of a class', () => {
      const { symbols } = parse(
        'public class Outer',
        '{',
        '    public int Field;',
        '    public void Method() { }',
        '    public class Inner { }',
        '    public enum Mode { A, B }',
        '    public delegate void Callback();',
        '    public record Rec(int X);',
        '}',
      );
      expect(symbols).toEqual([{ name: 'Outer', kind: 'class', startLine: 1, endLine: 9, exported: true }]);
    });

    it('does not list members of an interface or types nested in a struct', () => {
      const { symbols } = parse(
        'public interface IThing',
        '{',
        '    void Do();',
        '}',
        '',
        'public struct Holder',
        '{',
        '    public enum Kind { A }',
        '}',
      );
      expect(symbols).toEqual([
        { name: 'IThing', kind: 'interface', startLine: 1, endLine: 4, exported: true },
        { name: 'Holder', kind: 'class', startLine: 6, endLine: 9, exported: true },
      ]);
    });

    it('lists the types of a block namespace without listing the namespace', () => {
      const { symbols } = parse(
        'namespace Shop.Models',
        '{',
        '    public class User { }',
        '',
        '    public enum Role',
        '    {',
        '        Admin,',
        '    }',
        '}',
      );
      expect(symbols).toEqual([
        { name: 'User', kind: 'class', startLine: 3, endLine: 3, exported: true },
        { name: 'Role', kind: 'enum', startLine: 5, endLine: 8, exported: true },
      ]);
    });

    it('lists the types of a file-scoped namespace', () => {
      const { symbols } = parse(
        'namespace Shop.Models;',
        '',
        'public interface IUser',
        '{',
        '}',
        '',
        'public class User { }',
      );
      expect(symbols).toEqual([
        { name: 'IUser', kind: 'interface', startLine: 3, endLine: 5, exported: true },
        { name: 'User', kind: 'class', startLine: 7, endLine: 7, exported: true },
      ]);
    });

    it('lists types of nested namespaces in source order', () => {
      const { symbols } = parse(
        'namespace A',
        '{',
        '    public class One { }',
        '',
        '    namespace B',
        '    {',
        '        public class Two { }',
        '    }',
        '',
        '    public class Three { }',
        '}',
      );
      expect(symbols.map((s) => [s.name, s.startLine, s.endLine])).toEqual([
        ['One', 3, 3],
        ['Two', 7, 7],
        ['Three', 10, 10],
      ]);
    });

    it('lists the types of several namespaces in one file', () => {
      const { symbols } = parse(
        'namespace X',
        '{',
        '    class A',
        '    {',
        '    }',
        '}',
        'namespace Y',
        '{',
        '    class B { }',
        '}',
      );
      expect(symbols.map((s) => [s.name, s.startLine, s.endLine])).toEqual([
        ['A', 3, 5],
        ['B', 9, 9],
      ]);
    });

    it('lists mixed kinds in source order rather than grouped by kind', () => {
      const { symbols } = parse(
        'namespace Shop;',
        '',
        'public delegate void Done();',
        'public enum E { A }',
        'public interface I { }',
        'public record R(int X);',
        'public struct S { }',
        'public class C { }',
      );
      expect(symbols.map((s) => [s.name, s.kind, s.startLine])).toEqual([
        ['Done', 'type', 3],
        ['E', 'enum', 4],
        ['I', 'interface', 5],
        ['R', 'class', 6],
        ['S', 'class', 7],
        ['C', 'class', 8],
      ]);
    });

    it('lists only the types of a file that also has top-level statements and local functions', () => {
      const { symbols } = parse(
        'using System;',
        'Console.WriteLine("hi");',
        'void Local() { }',
        '',
        'class Program',
        '{',
        '}',
      );
      expect(symbols).toEqual([{ name: 'Program', kind: 'class', startLine: 5, endLine: 7, exported: true }]);
    });

    it('is empty for a file with usings and a namespace but no types', () => {
      expect(parse('using System;', 'namespace A.B;').symbols).toEqual([]);
    });

    it('counts lines the same with Windows line endings', () => {
      const { symbols } = adapter.parse('src/File.cs', ['public class A', '{', '}', ''].join('\r\n'));
      expect(symbols).toEqual([{ name: 'A', kind: 'class', startLine: 1, endLine: 3, exported: true }]);
    });

    it('ignores a leading byte order mark', () => {
      const parsed = adapter.parse('src/File.cs', '﻿using System;\nclass A { }');
      expect(parsed).toEqual({
        imports: ['System'],
        provides: [],
        symbols: [{ name: 'A', kind: 'class', startLine: 2, endLine: 2, exported: true }],
        parseError: false,
      });
    });
  });

  describe('parse errors', () => {
    it.each([
      ['an unclosed class body', 'public class Broken {'],
      ['a class without a name', 'namespace A { class }'],
      ['a using without a namespace', 'using ;'],
    ])('flags %s', (_label, source) => {
      expect(parse(source).parseError).toBe(true);
    });

    it('does not flag a realistic valid file', () => {
      const { parseError } = parse(
        'using System;',
        'using System.Collections.Generic;',
        'using System.Linq;',
        'using System.Threading.Tasks;',
        '',
        'namespace Shop.Orders;',
        '',
        'public sealed record Order(int Id, IReadOnlyList<string> Lines)',
        '{',
        '    public int Count => Lines.Count;',
        '}',
        '',
        'public class Service<T> where T : class',
        '{',
        '    private readonly List<T> items = new List<T>();',
        '',
        '    public async Task<T?> FindAsync(int id)',
        '    {',
        '        await Task.Delay(1);',
        '        var text = $"id={id}";',
        '        var names = items.Where(i => i != null).Select(i => i.ToString()).ToList();',
        '        using var reader = new System.IO.StringReader(text);',
        '        return items.FirstOrDefault();',
        '    }',
        '}',
      );
      expect(parseError).toBe(false);
    });

    it('returns empty results and no error for an empty file', () => {
      expect(parse('')).toEqual({ imports: [], provides: [], symbols: [], parseError: false });
    });

    it('does not throw on garbage input and flags it', () => {
      const source = '\u0000\u0001 }}{{ ;;; @@@ ### "unterminated';
      expect(() => parse(source)).not.toThrow();
      expect(parse(source).parseError).toBe(true);
    });
  });

  describe('resolve and resolveAll', () => {
    it('never resolves by path', () => {
      const everything = () => true;
      const results = ['System', 'Shop.Models', './Other', 'Other.cs'].map((s) => adapter.resolve('src/a.cs', s, everything));
      expect(results).toEqual([null, null, null, null]);
    });

    it('returns every provider of the specifier, in the order the providers gave them', () => {
      expect(resolveAll('Shop.Models', { 'Shop.Models': ['b.cs', 'a.cs'] })).toEqual(['b.cs', 'a.cs']);
    });

    it('does not retry the parent when the exact name has providers', () => {
      expect(resolveAll('A.B.C', { 'A.B.C': ['c.cs'], 'A.B': ['b.cs'] })).toEqual(['c.cs']);
    });

    it('retries the namespace without the last segment when the specifier has no providers', () => {
      expect(resolveAll('MyApp.Models.UserDto', { 'MyApp.Models': ['m.cs'] })).toEqual(['m.cs']);
    });

    it('retries down to a single-segment namespace', () => {
      expect(resolveAll('Shop.User', { Shop: ['s.cs'] })).toEqual(['s.cs']);
    });

    it('climbs only one level on a miss', () => {
      expect(resolveAll('A.B.C.D', { 'A.B': ['b.cs'], A: ['a.cs'] })).toEqual([]);
    });

    it('is empty for a single-segment specifier nobody provides', () => {
      expect(resolveAll('System', {})).toEqual([]);
    });

    it('does not trim a single-segment specifier when it retries', () => {
      expect(resolveAll('System', { Syste: ['x.cs'] })).toEqual([]);
    });

    it('does not match a single-segment specifier against the sub-namespaces that start with it', () => {
      expect(resolveAll('System', { 'System.Linq': ['l.cs'] })).toEqual([]);
    });

    it('is empty for a dotted specifier when neither it nor its parent has providers', () => {
      expect(resolveAll('Other.Ns', { Shop: ['s.cs'], 'Shop.Models': ['m.cs'] })).toEqual([]);
    });

    it('resolves a using alias of a type to the files of its namespace', () => {
      const { imports } = parse('using Dto = MyApp.Models.UserDto;');
      expect(imports.flatMap((i) => resolveAll(i, { 'MyApp.Models': ['Models/User.cs', 'Models/Dto.cs'] }))).toEqual(['Models/User.cs', 'Models/Dto.cs']);
    });
  });
});

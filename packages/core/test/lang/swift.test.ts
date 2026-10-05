import { beforeAll, describe, expect, it } from 'vitest';
import { createSwiftAdapter } from '../../src/lang/swift';
import type { LanguageAdapter } from '../../src/lang/types';

let adapter: LanguageAdapter;

beforeAll(async () => {
  adapter = await createSwiftAdapter();
});

const parse = (...lines: string[]) => adapter.parse('App/a.swift', lines.join('\n'));
const symbolsOf = (...lines: string[]) => parse(...lines).symbols;
const importsOf = (...lines: string[]) => parse(...lines).imports;
const providesOf = (path: string, source = 'struct A {}') => adapter.parse(path, source).provides ?? [];

describe('Swift adapter', () => {
  describe('file handling', () => {
    it('reports the swift language', () => {
      expect(adapter.lang).toBe('swift');
    });

    it('handles .swift files only', () => {
      expect(['a.swift', 'Sources/Core/a.swift'].filter((p) => !adapter.handles(p))).toEqual([]);
      expect(['a.ts', 'a.m', 'a.h', 'a.swiftmodule', 'a.swift.bak', 'a.txt', 'swift'].filter((p) => adapter.handles(p))).toEqual([]);
    });

    it('returns empty imports and symbols without an error for an empty file', () => {
      const result = adapter.parse('App/empty.swift', '');
      expect(result.imports).toEqual([]);
      expect(result.symbols).toEqual([]);
      expect(result.parseError).toBe(false);
    });
  });

  describe('imports', () => {
    it('takes the module name of a plain import', () => {
      expect(importsOf('import Foundation')).toEqual(['Foundation']);
    });

    it('takes only the first component of a submodule import', () => {
      expect(importsOf('import Foo.Bar', 'import Qux.Deep.Path')).toEqual(['Foo', 'Qux']);
    });

    it('takes the module of a kind-qualified import', () => {
      expect(importsOf(
        'import struct A.S',
        'import class B.C',
        'import enum C.E',
        'import protocol D.P',
        'import typealias E.T',
        'import func F.f',
      )).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    });

    it('takes the module of a @testable import', () => {
      expect(importsOf('@testable import Mod')).toEqual(['Mod']);
    });

    it('de-duplicates modules and keeps first-seen source order', () => {
      expect(importsOf(
        'import Foundation',
        'import struct Foo.Bar',
        'import Foo.Bar',
        '@testable import Mod',
        'import Foundation',
        'import UIKit',
      )).toEqual(['Foundation', 'Foo', 'Mod', 'UIKit']);
    });

    it('returns no imports when the file has none', () => {
      expect(importsOf('struct A {}')).toEqual([]);
    });

    it('ignores import text inside comments and string literals', () => {
      expect(importsOf(
        '// import HiddenLine',
        '/* import HiddenBlock */',
        'let doc = """',
        'import HiddenString',
        '"""',
        'import Real',
      )).toEqual(['Real']);
    });

    it('collects imports guarded by a compilation condition', () => {
      expect(importsOf(
        '#if canImport(UIKit)',
        'import UIKit',
        '#endif',
        'import Foundation',
      )).toEqual(['UIKit', 'Foundation']);
    });
  });

  describe('provides', () => {
    it('provides the target directory for a file under Sources, however deep the file is', () => {
      expect(providesOf('Sources/Core/a.swift')).toEqual(['Core']);
      expect(providesOf('Sources/Core/Net/Client.swift')).toEqual(['Core']);
    });

    it('provides the target of a nested package', () => {
      expect(providesOf('Packages/Kit/Sources/Kit/a.swift')).toEqual(['Kit']);
    });

    it('provides nothing for a file directly in Sources', () => {
      expect(providesOf('Sources/main.swift')).toEqual([]);
    });

    it('provides nothing for files under Tests', () => {
      expect(providesOf('Tests/CoreTests/CoreTests.swift')).toEqual([]);
    });

    it('provides nothing for files outside the SwiftPM layout', () => {
      expect(providesOf('App/Models/User.swift')).toEqual([]);
      expect(providesOf('Package.swift')).toEqual([]);
    });

    it('does not treat a directory that merely ends in Sources as the Sources root', () => {
      expect(providesOf('MySources/Core/a.swift')).toEqual([]);
    });

    it('derives provides from the path alone, even for an empty file', () => {
      expect(providesOf('Sources/Core/a.swift', '')).toEqual(['Core']);
    });
  });

  describe('symbols', () => {
    it('lists a class with its full range', () => {
      expect(symbolsOf(
        'class Box {',
        '    var value = 0',
        '}',
      )).toEqual([
        { name: 'Box', kind: 'class', startLine: 1, endLine: 3, exported: true },
      ]);
    });

    it('lists a struct as a class', () => {
      expect(symbolsOf(
        'struct Point {',
        '    var x: Int',
        '}',
      )).toEqual([
        { name: 'Point', kind: 'class', startLine: 1, endLine: 3, exported: true },
      ]);
    });

    it('lists an actor as a class', () => {
      expect(symbolsOf(
        'actor Counter {',
        '    var n = 0',
        '}',
      )).toEqual([
        { name: 'Counter', kind: 'class', startLine: 1, endLine: 3, exported: true },
      ]);
    });

    it('lists an enum as an enum without its cases', () => {
      expect(symbolsOf(
        'enum Color {',
        '    case red',
        '    case green',
        '}',
      )).toEqual([
        { name: 'Color', kind: 'enum', startLine: 1, endLine: 4, exported: true },
      ]);
    });

    it('lists a protocol as an interface without its requirements', () => {
      expect(symbolsOf(
        'protocol Shape {',
        '    func area() -> Double',
        '}',
      )).toEqual([
        { name: 'Shape', kind: 'interface', startLine: 1, endLine: 3, exported: true },
      ]);
    });

    it('lists a typealias as a type', () => {
      expect(symbolsOf('typealias ID = Int')).toEqual([
        { name: 'ID', kind: 'type', startLine: 1, endLine: 1, exported: true },
      ]);
    });

    it('lists a function with its full range', () => {
      expect(symbolsOf(
        'func run() {',
        '    print("go")',
        '}',
      )).toEqual([
        { name: 'run', kind: 'function', startLine: 1, endLine: 3, exported: true },
      ]);
    });

    it('lists global let and var as variables', () => {
      expect(symbolsOf(
        'let limit = 10',
        'var counter = 0',
      )).toEqual([
        { name: 'limit', kind: 'variable', startLine: 1, endLine: 1, exported: true },
        { name: 'counter', kind: 'variable', startLine: 2, endLine: 2, exported: true },
      ]);
    });

    it('spans a global variable across a multi-line initializer', () => {
      expect(symbolsOf(
        'let table = [',
        '    "a": 1,',
        '    "b": 2,',
        ']',
      )).toEqual([
        { name: 'table', kind: 'variable', startLine: 1, endLine: 4, exported: true },
      ]);
    });

    it('spans a computed global variable to its closing brace', () => {
      expect(symbolsOf(
        'var total: Int {',
        '    return 3',
        '}',
      )).toEqual([
        { name: 'total', kind: 'variable', startLine: 1, endLine: 3, exported: true },
      ]);
    });

    it('keeps source order across different kinds', () => {
      expect(symbolsOf(
        'func b() {}',
        'struct A {}',
        'let c = 1',
        'enum D {}',
      )).toEqual([
        { name: 'b', kind: 'function', startLine: 1, endLine: 1, exported: true },
        { name: 'A', kind: 'class', startLine: 2, endLine: 2, exported: true },
        { name: 'c', kind: 'variable', startLine: 3, endLine: 3, exported: true },
        { name: 'D', kind: 'enum', startLine: 4, endLine: 4, exported: true },
      ]);
    });

    it('starts the range at the first of several stacked attributes', () => {
      expect(symbolsOf(
        '@MainActor',
        '@available(macOS 12, *)',
        'open class Model {',
        '}',
      )).toEqual([
        { name: 'Model', kind: 'class', startLine: 1, endLine: 4, exported: true },
      ]);
    });

    it('starts a function range at its attribute', () => {
      expect(symbolsOf(
        '@discardableResult',
        'public func load() -> Int {',
        '    return 1',
        '}',
      )).toEqual([
        { name: 'load', kind: 'function', startLine: 1, endLine: 4, exported: true },
      ]);
    });

    it('does not include a preceding comment in the range', () => {
      expect(symbolsOf(
        '/// Docs for it',
        '// plain note',
        'struct Documented {',
        '}',
      )).toEqual([
        { name: 'Documented', kind: 'class', startLine: 3, endLine: 4, exported: true },
      ]);
    });

    it('spans a function whose signature covers several lines', () => {
      expect(symbolsOf(
        'public func configure(',
        '    name: String,',
        '    retries: Int',
        ') -> Bool {',
        '    return true',
        '}',
      )).toEqual([
        { name: 'configure', kind: 'function', startLine: 1, endLine: 6, exported: true },
      ]);
    });

    it('lists generic declarations by their plain name', () => {
      expect(symbolsOf(
        'struct Stack<Element> {',
        '    var items: [Element] = []',
        '}',
        '',
        'func swapValues<T>(_ a: inout T, _ b: inout T) {',
        '    let t = a',
        '    a = b',
        '    b = t',
        '}',
        '',
        'class Cache<Key: Hashable, Value> {',
        '    var store: [Key: Value] = [:]',
        '}',
        '',
        'typealias Pair<T> = (T, T)',
      )).toEqual([
        { name: 'Stack', kind: 'class', startLine: 1, endLine: 3, exported: true },
        { name: 'swapValues', kind: 'function', startLine: 5, endLine: 9, exported: true },
        { name: 'Cache', kind: 'class', startLine: 11, endLine: 13, exported: true },
        { name: 'Pair', kind: 'type', startLine: 15, endLine: 15, exported: true },
      ]);
    });

    it('does not list extensions or what they contain, and keeps listing what follows', () => {
      expect(symbolsOf(
        'struct Box {}',
        '',
        'extension Box {',
        '    func twice() -> Int { 2 }',
        '    struct Inner {}',
        '}',
        '',
        'extension Box: Equatable {',
        '}',
        '',
        'public extension Box {',
        '    var label: String { "box" }',
        '}',
        '',
        'func after() {}',
      )).toEqual([
        { name: 'Box', kind: 'class', startLine: 1, endLine: 1, exported: true },
        { name: 'after', kind: 'function', startLine: 15, endLine: 15, exported: true },
      ]);
    });

    it('does not list members or nested types', () => {
      expect(symbolsOf(
        'struct Outer {',
        '    struct Inner {}',
        '    enum Kind { case a }',
        '    static let shared = Outer()',
        '    var count = 0',
        '    func method() {}',
        '}',
      )).toEqual([
        { name: 'Outer', kind: 'class', startLine: 1, endLine: 7, exported: true },
      ]);
    });

    it('does not list declarations local to a function body', () => {
      expect(symbolsOf(
        'func outer() {',
        '    let local = 1',
        '    func inner() {}',
        '    struct Local {}',
        '}',
      )).toEqual([
        { name: 'outer', kind: 'function', startLine: 1, endLine: 5, exported: true },
      ]);
    });

    it('lists declarations inside a compilation-condition block as top-level', () => {
      expect(symbolsOf(
        '#if DEBUG',
        'let debugFlag = true',
        'func trace() {',
        '    print("x")',
        '}',
        '#endif',
        '',
        'struct After {}',
      )).toEqual([
        { name: 'debugFlag', kind: 'variable', startLine: 2, endLine: 2, exported: true },
        { name: 'trace', kind: 'function', startLine: 3, endLine: 5, exported: true },
        { name: 'After', kind: 'class', startLine: 8, endLine: 8, exported: true },
      ]);
    });
  });

  describe('exported', () => {
    it('is false for private on every kind of declaration', () => {
      expect(symbolsOf(
        'private class A {}',
        'private struct B {}',
        'private actor C {}',
        'private enum D {}',
        'private protocol E {}',
        'private typealias F = Int',
        'private func g() {}',
        'private let h = 1',
        'private var i = 2',
      )).toEqual([
        { name: 'A', kind: 'class', startLine: 1, endLine: 1, exported: false },
        { name: 'B', kind: 'class', startLine: 2, endLine: 2, exported: false },
        { name: 'C', kind: 'class', startLine: 3, endLine: 3, exported: false },
        { name: 'D', kind: 'enum', startLine: 4, endLine: 4, exported: false },
        { name: 'E', kind: 'interface', startLine: 5, endLine: 5, exported: false },
        { name: 'F', kind: 'type', startLine: 6, endLine: 6, exported: false },
        { name: 'g', kind: 'function', startLine: 7, endLine: 7, exported: false },
        { name: 'h', kind: 'variable', startLine: 8, endLine: 8, exported: false },
        { name: 'i', kind: 'variable', startLine: 9, endLine: 9, exported: false },
      ]);
    });

    it('is false for fileprivate', () => {
      expect(symbolsOf(
        'fileprivate struct S {}',
        'fileprivate func f() {}',
        'fileprivate let v = 1',
      )).toEqual([
        { name: 'S', kind: 'class', startLine: 1, endLine: 1, exported: false },
        { name: 'f', kind: 'function', startLine: 2, endLine: 2, exported: false },
        { name: 'v', kind: 'variable', startLine: 3, endLine: 3, exported: false },
      ]);
    });

    it('is true for public, open and internal', () => {
      expect(symbolsOf(
        'public class A {}',
        'open class B {}',
        'internal struct C {}',
        'public enum D {}',
        'public protocol E {}',
        'public func f() {}',
        'public let g = 1',
      )).toEqual([
        { name: 'A', kind: 'class', startLine: 1, endLine: 1, exported: true },
        { name: 'B', kind: 'class', startLine: 2, endLine: 2, exported: true },
        { name: 'C', kind: 'class', startLine: 3, endLine: 3, exported: true },
        { name: 'D', kind: 'enum', startLine: 4, endLine: 4, exported: true },
        { name: 'E', kind: 'interface', startLine: 5, endLine: 5, exported: true },
        { name: 'f', kind: 'function', startLine: 6, endLine: 6, exported: true },
        { name: 'g', kind: 'variable', startLine: 7, endLine: 7, exported: true },
      ]);
    });

    it('finds the access modifier whatever its position among attributes and modifiers', () => {
      expect(symbolsOf(
        '@MainActor',
        'private final class Hidden {',
        '}',
        '',
        'final fileprivate class Other {',
        '}',
      )).toEqual([
        { name: 'Hidden', kind: 'class', startLine: 1, endLine: 3, exported: false },
        { name: 'Other', kind: 'class', startLine: 5, endLine: 6, exported: false },
      ]);
    });

    it('stays true when only the name or a string contains the word private', () => {
      expect(symbolsOf(
        'let privateKey = "private"',
        'struct PrivateThing {}',
        'public func fileprivateHelper() {}',
      )).toEqual([
        { name: 'privateKey', kind: 'variable', startLine: 1, endLine: 1, exported: true },
        { name: 'PrivateThing', kind: 'class', startLine: 2, endLine: 2, exported: true },
        { name: 'fileprivateHelper', kind: 'function', startLine: 3, endLine: 3, exported: true },
      ]);
    });

    it('stays true for a type that only has a private member', () => {
      expect(symbolsOf(
        'struct Mixed {',
        '    private var secret = 1',
        '    func reveal() {}',
        '}',
      )).toEqual([
        { name: 'Mixed', kind: 'class', startLine: 1, endLine: 4, exported: true },
      ]);
    });
  });

  describe('parseError', () => {
    it('is false for valid modern Swift', () => {
      expect(parse(
        'import SwiftUI',
        '',
        '@MainActor',
        'final class ViewModel: ObservableObject {',
        '    @Published var items: [String] = []',
        '',
        '    func load() async throws {',
        '        let data = try await fetch()',
        '        guard !data.isEmpty else { return }',
        '        items = data.map { $0.uppercased() }',
        '    }',
        '}',
      ).parseError).toBe(false);
    });

    it('is true for a truncated function declaration', () => {
      expect(adapter.parse('App/bad.swift', 'func (').parseError).toBe(true);
    });

    it('is true for an unclosed brace', () => {
      expect(adapter.parse('App/bad.swift', 'struct Foo {').parseError).toBe(true);
    });

    it('is true for unbalanced garbage and never throws', () => {
      let result: ReturnType<LanguageAdapter['parse']> | undefined;
      expect(() => {
        result = adapter.parse('App/bad.swift', '}}}{{{ @@@ ((');
      }).not.toThrow();
      expect(result?.parseError).toBe(true);
    });
  });

  describe('module resolution', () => {
    const providers = (name: string) => (name === 'Core' ? ['Sources/Core/a.swift', 'Sources/Core/Net/b.swift'] : []);

    it('never resolves an import to a single file', () => {
      expect(adapter.resolve('Sources/App/main.swift', 'Core', () => true)).toBeNull();
      expect(adapter.resolve('Sources/App/main.swift', 'Foundation', () => false)).toBeNull();
    });

    it('resolveAll returns every file providing the module, in the order the lookup gives', () => {
      expect(adapter.resolveAll?.('Core', providers)).toEqual(['Sources/Core/a.swift', 'Sources/Core/Net/b.swift']);
    });

    it('resolveAll returns an empty list for a module nobody provides', () => {
      expect(adapter.resolveAll?.('Foundation', providers)).toEqual([]);
    });

    it('resolveAll looks the module up by exactly the given specifier', () => {
      const asked: string[] = [];
      adapter.resolveAll?.('Core', (name) => {
        asked.push(name);
        return [];
      });
      expect(asked).toEqual(['Core']);
    });
  });
});

/**
 * Unit tests for the Solver sheet bridge's pure parsing (src/solver/model.ts).
 * Address/range/constraint parsing needs no Univer; the live read/write
 * part is covered by the browser harness instead.
 */
import { describe, expect, it } from 'vitest';
import {
    cellAddress,
    indexToColumnLetters,
    parseCellAddress,
    parseConstraint,
    parseConstraintRight,
    parseRange,
    rangeAddress,
    rangeCells,
    rangeSize,
    columnLettersToIndex,
} from '../../src/solver/model';

describe('column letters', () => {
    it('converts letters to indexes and back', () => {
        expect(columnLettersToIndex('A')).toBe(0);
        expect(columnLettersToIndex('Z')).toBe(25);
        expect(columnLettersToIndex('AA')).toBe(26);
        expect(columnLettersToIndex('BM')).toBe(64);
        expect(columnLettersToIndex('XFD')).toBe(16383);
        expect(indexToColumnLetters(0)).toBe('A');
        expect(indexToColumnLetters(25)).toBe('Z');
        expect(indexToColumnLetters(26)).toBe('AA');
        expect(indexToColumnLetters(64)).toBe('BM');
        expect(indexToColumnLetters(16383)).toBe('XFD');
    });
});

describe('parseCellAddress', () => {
    it('parses plain, absolute, and lowercase addresses', () => {
        expect(parseCellAddress('A1')).toEqual({ row: 0, col: 0 });
        expect(parseCellAddress('$A$1')).toEqual({ row: 0, col: 0 });
        expect(parseCellAddress('A$1')).toEqual({ row: 0, col: 0 });
        expect(parseCellAddress('$A1')).toEqual({ row: 0, col: 0 });
        expect(parseCellAddress('a1')).toEqual({ row: 0, col: 0 });
        expect(parseCellAddress('BM60')).toEqual({ row: 59, col: 64 });
        expect(parseCellAddress('XFD1048576')).toEqual({ row: 1048575, col: 16383 });
    });

    it('rejects anything that is not a cell inside the sheet', () => {
        expect(parseCellAddress('')).toBeNull();
        expect(parseCellAddress('A0')).toBeNull();
        expect(parseCellAddress('A')).toBeNull();
        expect(parseCellAddress('1')).toBeNull();
        expect(parseCellAddress('A1B')).toBeNull();
        expect(parseCellAddress('A1:B2')).toBeNull();
        expect(parseCellAddress('XFE1')).toBeNull();
        expect(parseCellAddress('A1048577')).toBeNull();
        expect(parseCellAddress('  ')).toBeNull();
    });
});

describe('parseRange', () => {
    it('parses a single cell as a one-cell range', () => {
        expect(parseRange('A1')).toEqual({ start: { row: 0, col: 0 }, end: { row: 0, col: 0 } });
        expect(parseRange('$BM$60')).toEqual({
            start: { row: 59, col: 64 },
            end: { row: 59, col: 64 },
        });
    });

    it('parses a range and normalizes reversed ends', () => {
        expect(parseRange('A1:B2')).toEqual({
            start: { row: 0, col: 0 },
            end: { row: 1, col: 1 },
        });
        expect(parseRange('B2:A1')).toEqual({
            start: { row: 0, col: 0 },
            end: { row: 1, col: 1 },
        });
        expect(parseRange('$BM$31:$BM$49')).toEqual({
            start: { row: 30, col: 64 },
            end: { row: 48, col: 64 },
        });
    });

    it('rejects malformed ranges', () => {
        expect(parseRange('')).toBeNull();
        expect(parseRange('A1:B2:C3')).toBeNull();
        expect(parseRange('A0:B2')).toBeNull();
        expect(parseRange('A1:')).toBeNull();
        expect(parseRange(':B2')).toBeNull();
    });
});

describe('address formatting and range helpers', () => {
    it('round-trips addresses through parse and format', () => {
        expect(cellAddress({ row: 59, col: 64 })).toBe('BM60');
        expect(rangeAddress({ start: { row: 0, col: 0 }, end: { row: 0, col: 0 } })).toBe('A1');
        expect(rangeAddress({ start: { row: 0, col: 0 }, end: { row: 1, col: 1 } })).toBe('A1:B2');
    });

    it('lists range cells row-major with the right size', () => {
        const range = { start: { row: 0, col: 0 }, end: { row: 1, col: 1 } };
        expect(rangeCells(range)).toEqual([
            { row: 0, col: 0 },
            { row: 0, col: 1 },
            { row: 1, col: 0 },
            { row: 1, col: 1 },
        ]);
        expect(rangeSize(range)).toBe(4);
        expect(rangeSize({ start: { row: 30, col: 64 }, end: { row: 48, col: 64 } })).toBe(19);
    });
});

describe('parseConstraintRight', () => {
    it('parses numbers and cell addresses', () => {
        expect(parseConstraintRight('0.2')).toEqual({ kind: 'number', value: 0.2 });
        expect(parseConstraintRight('0')).toEqual({ kind: 'number', value: 0 });
        expect(parseConstraintRight('-1')).toEqual({ kind: 'number', value: -1 });
        expect(parseConstraintRight('1e3')).toEqual({ kind: 'number', value: 1000 });
        expect(parseConstraintRight('BM50')).toEqual({
            kind: 'cell',
            ref: { row: 49, col: 64 },
        });
        expect(parseConstraintRight('$BM$50')).toEqual({
            kind: 'cell',
            ref: { row: 49, col: 64 },
        });
    });

    it('rejects empty and unparseable right sides', () => {
        expect(parseConstraintRight('')).toBeNull();
        expect(parseConstraintRight('  ')).toBeNull();
        expect(parseConstraintRight('abc')).toBeNull();
        expect(parseConstraintRight('Infinity')).toBeNull();
    });
});

describe('parseConstraint', () => {
    it('parses a range constraint with a numeric right side', () => {
        expect(parseConstraint('BM31:BM49', '>=', '0')).toEqual({
            left: { start: { row: 30, col: 64 }, end: { row: 48, col: 64 } },
            operator: '>=',
            right: { kind: 'number', value: 0 },
        });
    });

    it('parses a cell constraint with a cell right side', () => {
        expect(parseConstraint('BM50', '<=', 'BM51')).toEqual({
            left: { start: { row: 49, col: 64 }, end: { row: 49, col: 64 } },
            operator: '<=',
            right: { kind: 'cell', ref: { row: 50, col: 64 } },
        });
    });

    it('rejects bad operators and bad sides', () => {
        expect(parseConstraint('A1', '>', '0')).toBeNull();
        expect(parseConstraint('A1', '=>', '0')).toBeNull();
        expect(parseConstraint('A0', '>=', '0')).toBeNull();
        expect(parseConstraint('A1', '>=', '')).toBeNull();
        expect(parseConstraint('A1', '=', 'abc')).toBeNull();
    });
});

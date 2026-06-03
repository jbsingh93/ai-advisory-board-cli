import { describe, expect, it } from 'vitest';
import {
  boardSlug,
  ensureUniqueBoardSlug,
  validateBoardFields,
  resolveBoardToken,
  dedupeMemberIds,
} from '../board-helpers.js';
import type { AdvisoryBoardMember, Board } from '../../../storage/types.js';

function mkMember(id: string, name: string, isActive = true): AdvisoryBoardMember {
  return {
    id,
    name,
    title: 't',
    expertise: [],
    persona: 'p',
    isActive,
    createdAt: '',
    updatedAt: '',
  };
}

function mkBoard(overrides: Partial<Board> = {}): Board {
  return {
    id: overrides.id ?? 'b1',
    name: overrides.name ?? 'Go To Market',
    slug: overrides.slug ?? 'go-to-market',
    description: overrides.description,
    memberIds: overrides.memberIds ?? ['m1'],
    createdAt: '',
    updatedAt: '',
    archivedAt: overrides.archivedAt,
  };
}

describe('boardSlug', () => {
  it('kebab-cases and lowercases', () => {
    expect(boardSlug('Go-To-Market Board!')).toBe('go-to-market-board');
  });
  it('falls back to "board" for empty', () => {
    expect(boardSlug('!!!')).toBe('board');
  });
});

describe('ensureUniqueBoardSlug', () => {
  it('returns base when free', () => {
    expect(ensureUniqueBoardSlug('gtm', ['tech'])).toBe('gtm');
  });
  it('suffixes -2 on first collision', () => {
    expect(ensureUniqueBoardSlug('gtm', ['gtm'])).toBe('gtm-2');
  });
  it('skips taken suffixes', () => {
    expect(ensureUniqueBoardSlug('gtm', ['gtm', 'gtm-2', 'gtm-3'])).toBe('gtm-4');
  });
});

describe('dedupeMemberIds', () => {
  it('preserves first-seen order', () => {
    expect(dedupeMemberIds(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });
});

describe('validateBoardFields', () => {
  const members = [mkMember('m1', 'A'), mkMember('m2', 'B')];

  it('passes a valid board', () => {
    expect(
      validateBoardFields(
        { name: 'New', description: 'ok', memberIds: ['m1'] },
        { existingBoards: [], members },
      ),
    ).toEqual([]);
  });

  it('rejects empty name', () => {
    const errs = validateBoardFields({ name: '  ', memberIds: ['m1'] }, { existingBoards: [], members });
    expect(errs.some((e) => /name is required/.test(e))).toBe(true);
  });

  it('rejects name > 100 chars', () => {
    const errs = validateBoardFields({ name: 'x'.repeat(101), memberIds: ['m1'] }, { existingBoards: [], members });
    expect(errs.some((e) => /≤ 100/.test(e))).toBe(true);
  });

  it('rejects duplicate name (case-insensitive)', () => {
    const errs = validateBoardFields(
      { name: 'go to market', memberIds: ['m1'] },
      { existingBoards: [mkBoard({ name: 'Go To Market' })], members },
    );
    expect(errs.some((e) => /already exists/.test(e))).toBe(true);
  });

  it('allows same name when excludeBoardId matches (self-edit)', () => {
    const errs = validateBoardFields(
      { name: 'Go To Market', memberIds: ['m1'] },
      { existingBoards: [mkBoard({ id: 'b1', name: 'Go To Market' })], members, excludeBoardId: 'b1' },
    );
    expect(errs).toEqual([]);
  });

  it('rejects description > 500 chars', () => {
    const errs = validateBoardFields(
      { name: 'N', description: 'x'.repeat(501), memberIds: ['m1'] },
      { existingBoards: [], members },
    );
    expect(errs.some((e) => /≤ 500/.test(e))).toBe(true);
  });

  it('rejects zero members', () => {
    const errs = validateBoardFields({ name: 'N', memberIds: [] }, { existingBoards: [], members });
    expect(errs.some((e) => /at least one member/.test(e))).toBe(true);
  });

  it('rejects unknown member ids', () => {
    const errs = validateBoardFields({ name: 'N', memberIds: ['m1', 'ghost'] }, { existingBoards: [], members });
    expect(errs.some((e) => /unknown member id\(s\): ghost/.test(e))).toBe(true);
  });
});

describe('resolveBoardToken', () => {
  const boards = [
    mkBoard({ id: 'b1', name: 'Go To Market', slug: 'go-to-market' }),
    mkBoard({ id: 'b2', name: 'Technical', slug: 'technical' }),
  ];
  it('matches by exact id', () => {
    expect(resolveBoardToken(boards, 'b2')?.id).toBe('b2');
  });
  it('matches by exact slug', () => {
    expect(resolveBoardToken(boards, 'technical')?.id).toBe('b2');
  });
  it('matches by case-insensitive name', () => {
    expect(resolveBoardToken(boards, 'go to market')?.id).toBe('b1');
  });
  it('matches by slug prefix', () => {
    expect(resolveBoardToken(boards, 'go-to')?.id).toBe('b1');
  });
  it('returns undefined on no match', () => {
    expect(resolveBoardToken(boards, 'zzz')).toBeUndefined();
  });
});

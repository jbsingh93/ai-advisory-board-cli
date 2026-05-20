import { describe, expect, it } from 'vitest';
import {
  normalizePriority,
  normalizeStatus,
  shortActionId,
} from '../actions.js';
import { UserError } from '../../core/errors.js';

describe('shortActionId', () => {
  it('returns the first 8 chars of an id', () => {
    expect(shortActionId('abcdef1234-deadbeef')).toBe('abcdef12');
  });
});

describe('normalizePriority', () => {
  it('accepts canonical values', () => {
    expect(normalizePriority('high')).toBe('high');
    expect(normalizePriority(' MEDIUM ')).toBe('medium');
    expect(normalizePriority('Low')).toBe('low');
  });

  it('throws on bad input', () => {
    expect(() => normalizePriority('urgent')).toThrow(UserError);
  });
});

describe('normalizeStatus', () => {
  it('accepts canonical values', () => {
    expect(normalizeStatus('pending')).toBe('pending');
    expect(normalizeStatus('in-progress')).toBe('in-progress');
    expect(normalizeStatus('completed')).toBe('completed');
  });

  it('aliases inprogress, doing → in-progress', () => {
    expect(normalizeStatus('inprogress')).toBe('in-progress');
    expect(normalizeStatus('in_progress')).toBe('in-progress');
    expect(normalizeStatus('doing')).toBe('in-progress');
  });

  it('aliases todo → pending and done → completed', () => {
    expect(normalizeStatus('todo')).toBe('pending');
    expect(normalizeStatus('done')).toBe('completed');
  });

  it('throws on unknown', () => {
    expect(() => normalizeStatus('backlog')).toThrow(UserError);
  });
});

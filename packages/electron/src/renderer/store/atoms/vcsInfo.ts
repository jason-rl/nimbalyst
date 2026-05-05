import { atom } from 'jotai';
import type { VcsInfo } from '../../../shared/vcs/types';

export const vcsInfoAtom = atom<VcsInfo | null>(null);

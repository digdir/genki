import type { Translation } from '@genai/i18n';
import type { core as source } from '../nb/core';
import { common, rights, taskStatus } from './core-common';
import { apiCall, components, publish, resultTable, runFailure } from './core-components';
import { app, devTools, notFound, profile, shell } from './core-shell';
import {
  changes,
  getStarted,
  noAccess,
  overview,
  servicesScreen,
  unregistered,
} from './core-screens';
import { about } from './core-about';
import { dataHandling, start } from './core-start';
import { states } from './core-states';

export const core = {
  common,
  rights,
  taskStatus,
  components,
  apiCall,
  runFailure,
  publish,
  resultTable,
  states,
  shell,
  profile,
  notFound,
  devTools,
  app,
  start,
  about,
  dataHandling,
  overview,
  getStarted,
  changes,
  servicesScreen,
  noAccess,
  unregistered,
} satisfies Translation<typeof source>;

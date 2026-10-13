import { common, rights, taskStatus } from './core-common';
import { apiCall, components, publish, resultTable, runFailure } from './core-components';
import { app, shell } from './core-shell';
import { changes, noAccess, overview, servicesScreen, unregistered } from './core-screens';
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
  app,
  start,
  dataHandling,
  overview,
  changes,
  servicesScreen,
  noAccess,
  unregistered,
} as const;

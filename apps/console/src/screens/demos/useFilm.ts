import { useMemo } from 'react';
import type { ApiClient, DemoRecording } from '../../api';
import { useAsync } from '../../hooks';
import {
  cuesOf,
  timelineOf,
  timelineOfCues,
  type Cue,
  type FilmEdl,
  type FilmEvents,
  type Timeline,
} from './film';
import { hasFile } from './shared';

export const hasEditList = (recording: DemoRecording | undefined) =>
  recording?.status === 'recorded' &&
  recording.upTo === undefined &&
  hasFile(recording, 'capture.mp4') &&
  hasFile(recording, 'edl.json') &&
  hasFile(recording, 'events.json');

const text = async (api: ApiClient, recording: string, name: string, signal: AbortSignal) =>
  (await api.demoFile(recording, name, signal)).text();

interface Loaded {
  cues: Cue[];
  edl?: FilmEdl;
  events?: FilmEvents;
}

export interface Film {
  loading: boolean;
  cues: Cue[];
  timeline: Timeline | undefined;
  unreadable: boolean;
}

export const useFilm = (
  api: ApiClient,
  recording: DemoRecording | undefined,
  says: string[],
): Film => {
  const [state] = useAsync<Loaded | undefined>(
    async (signal) => {
      if (!recording) return undefined;
      const srt = hasFile(recording, 'demo.srt')
        ? await text(api, recording.id, 'demo.srt', signal).catch(() => '')
        : '';
      const cues = cuesOf(srt);
      if (!hasEditList(recording)) return { cues };
      try {
        return {
          cues,
          edl: JSON.parse(await text(api, recording.id, 'edl.json', signal)) as FilmEdl,
          events: JSON.parse(await text(api, recording.id, 'events.json', signal)) as FilmEvents,
        };
      } catch {
        return { cues };
      }
    },
    [api, recording?.id],
  );
  const loaded = state.status === 'ready' ? state.data : undefined;
  return useMemo(() => {
    if (!loaded)
      return {
        loading: state.status === 'loading',
        cues: [],
        timeline: undefined,
        unreadable: false,
      };
    let unreadable = false;
    if (loaded.edl && loaded.events) {
      try {
        return {
          loading: false,
          cues: loaded.cues,
          timeline: timelineOf(loaded.edl, loaded.events),
          unreadable,
        };
      } catch {
        unreadable = true;
      }
    }
    const timeline =
      loaded.cues.length > 0 && loaded.cues.length === says.length
        ? timelineOfCues(loaded.cues, says, recording?.seconds ?? 0)
        : undefined;
    return { loading: false, cues: loaded.cues, timeline, unreadable };
  }, [loaded, says, state.status, recording?.seconds]);
};

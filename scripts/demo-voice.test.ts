import { describe, expect, it } from 'vitest';
import {
  audioRequest,
  audioUrl,
  bestTake,
  goodEnough,
  isModelVoice,
  OverCap,
  refuseOverCap,
  spendOf,
  readerInstruction,
  sameWord,
  transcriptionUrl,
  wordDistance,
  wordsOf,
} from './demo-voice.ts';

const take = (text: string) => Buffer.from(text);

describe('the model voice', () => {
  it('knows cedar as a model voice and leaves Azure voice names to Azure Speech', () => {
    expect(isModelVoice('cedar')).toBe(true);
    expect(isModelVoice('nb-NO-PernilleNeural')).toBe(false);
  });

  it('asks for the line word for word in natural eastern Norwegian bokmål', () => {
    const body = audioRequest('Dette er Genki.', 'cedar', 'nb-NO');
    expect(body.audio).toEqual({ voice: 'cedar', format: 'mp3' });
    expect(body.messages[0]?.content).toBe(readerInstruction('nb-NO'));
    expect(readerInstruction('nb-NO')).toContain('østlandsk');
    expect(readerInstruction('nb-NO')).toContain('ordrett');
    expect(body.messages[1]?.content).toBe('Les opp:\nDette er Genki.');
    expect(readerInstruction('en-GB')).toContain('British');
  });

  it('sends the Entra token only to an https Azure AI endpoint', () => {
    expect(audioUrl('https://genki-test-ai.cognitiveservices.azure.com/')).toBe(
      'https://genki-test-ai.cognitiveservices.azure.com/openai/deployments/gpt-audio-1.5/chat/completions?api-version=2025-04-01-preview',
    );
    expect(() => audioUrl('http://genki-test-ai.cognitiveservices.azure.com')).toThrow();
    expect(() => audioUrl('https://evil.example/x.cognitiveservices.azure.com')).toThrow();
    expect(() => audioUrl('https://cognitiveservices.azure.com.evil.example')).toThrow();
    expect(() => audioUrl('https://a.openai.azure.com', '../x')).toThrow();
  });

  it('hears the line back in the demo language', () => {
    expect(transcriptionUrl('https://speech.cognitiveservices.azure.com/', 'nb-NO')).toBe(
      'https://speech.cognitiveservices.azure.com/stt/speech/recognition/conversation/cognitiveservices/v1?language=nb-NO&format=detailed',
    );
  });

  it('compares words without punctuation or case, with numbers as digits', () => {
    expect(wordsOf('Tre tjenester, «Genki»!')).toEqual(['3', 'tjenester', 'genki']);
    expect(wordDistance(wordsOf('Det er tre.'), wordsOf('det er 3'))).toBe(0);
  });

  it('counts a name the speech service spells a little differently as the same word', () => {
    expect(sameWord('genki', 'genchi')).toBe(true);
    expect(sameWord('ansattporten', 'ansattfarten')).toBe(true);
    expect(sameWord('modell', 'kvote')).toBe(false);
  });

  it('counts missing, extra and wrong words', () => {
    expect(wordDistance(['a1', 'b2', 'c3'], ['a1', 'c3'])).toBe(1);
    expect(wordDistance(['a1'], ['a1', 'x9', 'y8'])).toBe(2);
    expect(wordDistance(['hund'], ['katt'])).toBe(1);
  });

  it('accepts a take with at most two words off, or five percent of a long line', () => {
    expect(goodEnough(2, 10)).toBe(true);
    expect(goodEnough(3, 10)).toBe(false);
    expect(goodEnough(3, 60)).toBe(true);
  });

  it('reads the line again until it is heard as written, and stops there', async () => {
    const heard = ['Noe helt annet enn det', 'Dette er Genki', 'Dette er Genki'];
    let reads = 0;
    const result = await bestTake(
      'Dette er Genki',
      () => Promise.resolve(take(`take ${++reads}`)),
      () => Promise.resolve(heard[reads - 1] ?? ''),
    );
    expect(reads).toBe(2);
    expect(result.audio.toString()).toBe('take 2');
    expect(result.takes.map((t) => t.distance)).toEqual([5, 0]);
  });

  it('keeps the best of four takes when none is good enough', async () => {
    const heard = ['x y z w v', 'Dette x y z', 'x y z w', 'a b c d e'];
    let reads = 0;
    const result = await bestTake(
      'Dette er Genki i dag',
      () => Promise.resolve(take(`take ${++reads}`)),
      () => Promise.resolve(heard[reads - 1] ?? ''),
    );
    expect(reads).toBe(4);
    expect(result.audio.toString()).toBe('take 2');
  });
});

describe('the approved cost', () => {
  it('refuses a model call nobody has approved a cost cap for', () => {
    expect(() => refuseOverCap(spendOf(), 0.01, 'Reading')).toThrow(OverCap);
    expect(() => refuseOverCap(spendOf(0), 0.01, 'Reading')).toThrow(/nobody has approved/);
  });

  it('refuses a model call that could cost more than what is left of the cap', () => {
    const spend = spendOf(2, 1.5);

    expect(() => refuseOverCap(spend, 0.4, 'Reading')).not.toThrow();
    expect(() => refuseOverCap(spend, 0.6, 'Reading')).toThrow(
      /0\.50 USD left of the approved 2 USD/,
    );
  });
});

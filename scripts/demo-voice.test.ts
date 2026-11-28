import { describe, expect, it } from 'vitest';
import {
  audioRequest,
  audioUrl,
  bestTake,
  isModelVoice,
  maxClipBytes,
  modelAudio,
  modelVoiceId,
  OverCap,
  refuseOverCap,
  speechLocale,
  spendOf,
  readerInstruction,
  respell,
  sameWord,
  scoreTake,
  spokenText,
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

  it('keeps the takes already heard when a later take fails, and fails when the first one does', async () => {
    let reads = 0;
    const result = await bestTake(
      'Dette er Genki i dag',
      () => (++reads === 1 ? Promise.resolve(take('take 1')) : Promise.reject(new Error('429'))),
      () => Promise.resolve('Dette er Genki'),
    );
    expect(result.audio.toString()).toBe('take 1');
    await expect(
      bestTake(
        'Hei',
        () => Promise.reject(new Error('429')),
        () => Promise.resolve('Hei'),
      ),
    ).rejects.toThrow('429');
  });
});

describe('scoring a take', () => {
  it('counts the content words it did not hear, twice, and the words it heard that were never written', () => {
    const take = scoreTake(
      'Loggen viser hver kjøring, med status, tid og kostnad.',
      'Loggen viser hver kjøring med status og pris',
    );
    expect(take.missing).toEqual(['kostnad']);
    expect(take.extra).toEqual(['pris']);
    expect(take.score).toBe(3);
  });

  it('weighs a missed key term such as Ansattporten above an ordinary word', () => {
    const plain = scoreTake('Ansatte logger inn med portalen.', 'Ansatte logger inn med');
    const term = scoreTake('Ansatte logger inn med Ansattporten.', 'Ansatte logger inn med');
    expect(term.keyTermsMissing).toEqual(['ansattporten']);
    expect(term.score).toBeGreaterThan(plain.score);
  });

  it('gives a clean take with a natural pace a score of 0, and marks a rushed or dragging one', () => {
    const text = 'Genki er Digdirs felles plattform for KI-tjenester.';
    expect(scoreTake(text, text, 3.5)).toMatchObject({ score: 0, wordsPerSecond: 2.29 });
    expect(scoreTake(text, text, 1.5).score).toBe(2);
    expect(scoreTake(text, text, 8).score).toBe(2);
  });

  it('leaves the pace of a short line alone, since its clip is mostly silence', () => {
    expect(scoreTake('Men svarer tjenesten riktig?', 'Men svarer tjenesten riktig', 3).score).toBe(
      0,
    );
  });

  it('ignores small words and how the speech service spells a name', () => {
    expect(
      scoreTake('Dette er Genki, og det er i test.', 'dette er jenki og det er i test').score,
    ).toBe(0);
  });

  it('keeps the take with the best score, hearing each one back', async () => {
    const heard = ['Det er Genki i test', 'Dette er Genki i test nå', 'Dette er Genki'];
    let reads = 0;
    const result = await bestTake(
      'Dette er Genki i test nå',
      () => Promise.resolve(take(`take ${++reads}`)),
      () => Promise.resolve(heard[reads - 1] ?? ''),
      3,
      () => 2.5,
    );
    expect(reads).toBe(2);
    expect(result.audio.toString()).toBe('take 2');
    expect(result.takes.map((t) => t.score)).toEqual([2, 0]);
    expect(result.wordsPerSecond).toBe(2.4);
  });
});

describe('what the voice says', () => {
  it('says a word the way the glossary spells it, as a whole word only', () => {
    expect(
      respell('Genki er Digdirs. Genkis? genki', { Genki: 'Genn-ki', Digdirs: 'Digg-dirs' }),
    ).toBe('Genn-ki er Digg-dirs. Genkis? genki');
    expect(
      respell('Gå til genki.digdir.cloud.', { 'genki.digdir.cloud': 'genki punktum cloud' }),
    ).toBe('Gå til genki punktum cloud.');
  });

  it('respells in time linear in the length of the line', () => {
    const line = 'Genk'.repeat(50_000);
    const started = performance.now();
    respell(line, { Genki: 'Genn-ki', Genkk: 'x', G: 'y' });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('reads the platform glossary for the provider, the demo glossary over it, and the line own spoken text over both', () => {
    const line = { say: 'Genki er Digdirs plattform.' };
    expect(spokenText(line, 'elevenlabs-film', 'nb-NO')).toBe('Genn-ki er Digg-dirs plattform.');
    expect(spokenText(line, 'elevenlabs-film', 'nb-NO', { elevenlabs: { Genki: 'Gjen-ki' } })).toBe(
      'Gjen-ki er Digg-dirs plattform.',
    );
    expect(
      spokenText(
        { ...line, spoken: { elevenlabs: 'Gen-ki, Digdir.' } },
        'elevenlabs-film',
        'nb-NO',
      ),
    ).toBe('Gen-ki, Digdir.');
  });

  it('leaves the shown text alone for a provider the glossary does not name', () => {
    const line = { say: 'Genki er Digdirs plattform.', spoken: { elevenlabs: 'Genn-ki' } };
    expect(spokenText(line, 'nb-NO-PernilleNeural', 'nb-NO')).toBe(line.say);
    expect(spokenText(line, 'cedar', 'nb-NO')).toBe(line.say);
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

  it('sends the audio model only a model voice from the catalogue', () => {
    expect(modelVoiceId('cedar')).toBe('cedar');
    expect(() => modelVoiceId('nb-NO-PernilleNeural')).toThrow(/not a model voice/);
    expect(() => modelVoiceId('cedar"}')).toThrow(/not a model voice/);
  });

  it('asks speech to text only for a locale a demo voice speaks', () => {
    expect(speechLocale('en-GB')).toBe('en-GB');
    expect(() => speechLocale('nb')).toThrow(/not nb/);
    expect(() => speechLocale('nb-NO&format=simple')).toThrow();
  });

  it('takes model audio only when it is mp3 of at most 2 MiB', () => {
    const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(10)]);
    const frame = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
    expect(modelAudio(id3.toString('base64'))).toEqual(id3);
    expect(modelAudio(frame.toString('base64'))).toEqual(frame);
    expect(() => modelAudio(Buffer.from('RIFF....WAVE').toString('base64'))).toThrow(
      /other than mp3/,
    );
    const big = Buffer.concat([id3, Buffer.alloc(maxClipBytes)]).toString('base64');
    expect(() => modelAudio(big)).toThrow(/more than/);
  });
});

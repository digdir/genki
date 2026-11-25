export interface DemoVoice {
  id: string;
  name: string;
  language: 'nb-NO' | 'en-GB' | 'en-US';
  gender: 'female' | 'male';
}

export const demoVoices: readonly DemoVoice[] = [
  { id: 'nb-NO-PernilleNeural', name: 'Pernille', language: 'nb-NO', gender: 'female' },
  { id: 'nb-NO-IselinNeural', name: 'Iselin', language: 'nb-NO', gender: 'female' },
  { id: 'nb-NO-FinnNeural', name: 'Finn', language: 'nb-NO', gender: 'male' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia', language: 'en-GB', gender: 'female' },
  { id: 'en-GB-RyanNeural', name: 'Ryan', language: 'en-GB', gender: 'male' },
  { id: 'en-US-AvaNeural', name: 'Ava', language: 'en-US', gender: 'female' },
  { id: 'en-US-JennyNeural', name: 'Jenny', language: 'en-US', gender: 'female' },
  { id: 'en-US-AndrewNeural', name: 'Andrew', language: 'en-US', gender: 'male' },
  { id: 'en-US-GuyNeural', name: 'Guy', language: 'en-US', gender: 'male' },
];

export const demoVoiceOf = (id: string) => demoVoices.find((v) => v.id === id);

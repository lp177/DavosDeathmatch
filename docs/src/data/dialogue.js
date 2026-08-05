/* ══════════════════════════════════════════════════════════════
   Dialogue.

   Every line is drawn from something the figure actually said or a
   scandal they actually had. That is the whole engine of the joke: a
   made-up line is just a cartoon, whereas a real quote delivered while
   someone is being kicked through a conference centre is satire.

   Lines are grouped by moment and drawn from a shuffle bag, so a
   character works through everything they can say before repeating —
   which is what stops "How dare you" from becoming wallpaper.

   Entries are either a plain string or {text, style}, where style picks
   one of the character's voice presets. A "|" marks a beat for the
   speech engine.
   ══════════════════════════════════════════════════════════════ */

export const DIALOGUE = {

  /* ═══ DONALD TRUMP ═══ */
  trump: {
    intro: [
      'I could stand in the middle of Fifth Avenue and shoot somebody| and not lose any voters.',
      'Nobody knows fighting better than me. Nobody.',
      'I know words.| I have the best words.',
      'This is going to be tremendous. Believe me.',
      'I alone can fix it.',
      'We are going to win so much| you will get tired of winning.',
    ],
    taunt: [
      "You're fired!",
      'Sad!',
      'Fake news.',
      'Tremendous. Just tremendous.',
      'Nobody has ever seen anything like it.',
      'I have a very good brain.',
      'Person.| Woman.| Man.| Camera.| TV.',
      'It started with a small loan of a million dollars.',
      'Covfefe.',
      'Nobody knew fighting could be so complicated.',
      'Two Corinthians. Great book.',
      'Bigly.',
    ],
    hurt: [
      'This is a witch hunt!',
      'Nobody has ever been treated worse than me.',
      'It will go away.| Like a miracle,| it will go away.',
      'That was a perfect fight. A perfect fight.',
      'Rigged! This whole thing is rigged!',
      'Stop the count!',
    ],
    ko: [
      'I won. I won by a lot.',
      'The referee was totally biased. Everybody knows it.',
      'We are going to appeal this. Bigly.',
    ],
    win: [
      'I have the best knockouts. Everybody says so.',
      'This was a rigged fight,| and I still won it. Bigly.',
      'Nobody respects a loser. Nobody.',
      'They said it could not be done.| I did it.| I did it better than anybody.',
      'Maybe we try injecting a disinfectant next time.',
    ],
  },

  /* ═══ GRETA THUNBERG ═══ */
  greta: {
    intro: [
      { text: 'Our house| is on fire.', style: 'rage' },
      { text: 'I want you to panic.', style: 'rage' },
      { text: 'I should not be up here.| I should be back at school| on the other side of the ocean.', style: 'grief' },
      { text: 'The eyes of all future generations| are upon you.', style: 'rage' },
      { text: 'You are failing us.', style: 'rage' },
    ],
    taunt: [
      { text: 'You have stolen my dreams| and my childhood| with your empty words.', style: 'grief' },
      { text: 'How.| Dare.| You.', style: 'rage' },
      { text: 'Blah, blah, blah.| Blah, blah, blah.', style: 'weary' },
      { text: 'Build back better.| Blah, blah, blah.| Net zero by twenty fifty.| Blah, blah, blah.', style: 'weary' },
      { text: 'We will never forgive you.', style: 'rage' },
      { text: 'Listen to the science.', style: 'weary' },
      { text: 'Skolstrejk| för klimatet.', style: 'rage' },
    ],
    hurt: [
      { text: 'This is all wrong.', style: 'grief' },
      { text: 'How can you pretend| that this can be solved| with business as usual?', style: 'rage' },
      { text: 'You are not mature enough| to tell it like it is.', style: 'rage' },
      { text: 'I am not the one who should be doing this.', style: 'grief' },
    ],
    ko: [
      { text: 'We will not let you get away with this.', style: 'rage' },
      { text: 'Right here,| right now| is where we draw the line.', style: 'rage' },
      { text: 'You will be judged| by the generations to come.', style: 'grief' },
    ],
    win: [
      { text: 'Change is coming,| whether you like it| or not.', style: 'rage' },
      { text: 'This is all wrong.| I should not be up here.', style: 'grief' },
      { text: 'You cannot negotiate| with physics.', style: 'rage' },
      { text: 'Hope is not something you ask for.| It is something you earn.', style: 'grief' },
    ],
  },

  /* ═══ KIM JONG UN ═══ */
  kim: {
    intro: [
      'The mentally deranged dotard| will be tamed with fire.',
      'This is a peaceful scientific test.',
      'Our treasured sword| is ready.',
      'The Supreme Leader has already decided the outcome.',
    ],
    taunt: [
      'Rocket man?| I like that.',
      'The nuclear button is on my desk at all times.',
      'My button is bigger.| And it works.',
      'The Supreme Leader is pleased.',
      'Our scientists are taking notes.',
      'This is entirely defensive.',
      'The whole nation is weeping with joy.',
    ],
    hurt: [
      'This is a provocation!',
      'A sea of fire awaits you.',
      'The eternal leadership does not fall.',
      'This was not authorised by the party.',
    ],
    ko: [
      'The test was a partial success.',
      'The party will review the footage.',
      'Somebody is going to be reassigned for this.',
    ],
    win: [
      'The revolution is glorious,| and so am I.',
      'Our scientists will study your defeat for decades.',
      'We will reduce you to ashes.',
      'This victory will be taught in every school.',
    ],
  },

  /* ═══ VLADIMIR PUTIN ═══ */
  putin: {
    intro: [
      'This is not a war.| It is a special operation.',
      'Judo teaches you| to use your opponent\'s weight| against him.',
      'Whether you like it or not,| my beauty,| you will have to put up with it.',
      'We are simply protecting our interests.',
    ],
    taunt: [
      'There is no war.',
      'It is a special operation.',
      'Judo is about balance.',
      'Why would we need a world| if Russia is not in it?',
      'Everything is going according to the plan.',
      'That was an entirely internal matter.',
      'Denazification is proceeding.',
    ],
    hurt: [
      'This is Western aggression.',
      'Traitors will choke| on their thirty pieces of silver.',
      'We have not even started| in earnest yet.',
      'A tragic accident. Obviously.',
    ],
    ko: [
      'It sank.',
      'The operation is being regrouped.',
      'This was always the plan.',
    ],
    win: [
      'The operation concluded ahead of schedule.',
      'Everything went according to the plan.| There was always a plan.',
      'We will go to heaven as martyrs.| They will simply die.',
      'It sank.',
    ],
  },

  /* ═══ EMMANUEL MACRON ═══ */
  macron: {
    intro: [
      'En même temps,| I am going to win| and you are going to lose.',
      'It is not the street| that governs.',
      'There are those who succeed| and those who are nothing.',
      'This reform is necessary. I have decided.',
    ],
    taunt: [
      'Cross the street,| I will find you a job.',
      'En même temps…',
      'The French are Gauls| resistant to change.',
      'A crazy amount of money.',
      'I have a very strong desire| to annoy them.',
      'It is not the street that governs.',
      'I am accountable to history,| not to you.',
    ],
    hurt: [
      'This is populism!',
      'I hear your anger.| I have decided anyway.',
      'We will pass it| without a vote if necessary.',
      'The reform is necessary.| It remains necessary.',
    ],
    ko: [
      'I take full responsibility.| Nothing will change.',
      'This is a temporary setback| in a long reform.',
      'Article forty nine point three.| I invoke it.',
    ],
    win: [
      'I hear your anger,| and I have decided anyway.',
      'This reform was necessary.| History will thank me.',
      'Two more years. Only two.',
      'Jupiter descends| only to strike.',
    ],
  },

  /* ═══ ELON MUSK ═══ */
  musk: {
    intro: [
      'Let that| sink in.',
      'Funding secured.',
      'I am become meme.',
      'Comedy is now legal here.',
    ],
    taunt: [
      'Concerning.',
      'Interesting…',
      'We are shipping it tonight.',
      'Take the red pill.',
      'Delete your account.',
      'We will coup whoever we want.| Deal with it.',
      'The glass is armoured.| Watch this.',
      'Four twenty. Funding secured.',
    ],
    hurt: [
      'This is a legacy media hit piece.',
      'That is a false narrative.',
      'The window was already cracked.',
      'Concerning.| Very concerning.',
    ],
    ko: [
      'That was technically a beta test.',
      'Rapid unscheduled disassembly.',
      'We learned a lot from that flight.',
    ],
    win: [
      'Funding secured.',
      'That was technically a beta test.',
      'We are making life multiplanetary.| You are not invited.',
      'Occupy Mars.',
    ],
  },

  /* ═══ JAVIER MILEI ═══ */
  milei: {
    intro: [
      { text: 'The West| is in danger!', style: 'rage' },
      { text: 'I did not come to lead sheep.| I came to awaken lions!', style: 'rage' },
      { text: 'The state is the enemy!', style: 'rage' },
      { text: 'Viva la libertad,| carajo!', style: 'rage' },
    ],
    taunt: [
      { text: 'No hay plata!', style: 'rage' },
      { text: 'Afuera!', style: 'rage' },
      { text: 'Viva la libertad,| carajo!', style: 'rage' },
      'The politicians are a caste.',
      'Taxation is theft.',
      'I consulted my dogs. They agree.',
      { text: 'Zurdos!| Get out!', style: 'rage' },
    ],
    hurt: [
      'This is the caste fighting back!',
      { text: 'There is no money!', style: 'rage' },
      'The adjustment will be painful| but it will be short.',
      'Nobody said liberty was free.',
    ],
    ko: [
      'The chainsaw needs sharpening.',
      { text: 'Afuera…| afuera…', style: 'rage' },
      'The market will correct this.',
    ],
    win: [
      'The state was the problem.| You were the state.',
      { text: 'Afuera!| Next!', style: 'rage' },
      'I did not come to lead sheep.',
      { text: 'Viva la libertad,| carajo!', style: 'rage' },
    ],
  },

  /* ═══ KLAUS SCHWAB ═══ */
  schwab: {
    intro: [
      'Welcome to Davos.',
      'The Fourth Industrial Revolution| will change everything about you.',
      'We must reset.',
      'Stakeholder capitalism| begins now.',
    ],
    taunt: [
      'You will own nothing.',
      'And you will be happy.',
      'The stakeholders have decided.',
      'We penetrate the cabinets.',
      'This is a public private partnership.',
      'By twenty thirty| you will own nothing.',
      'The future is built by us.',
    ],
    hurt: [
      'This was not on the agenda.',
      'The forum will need to convene.',
      'A minor externality.',
      'We will build back better.',
    ],
    ko: [
      'The Great Reset| is merely delayed.',
      'We will reconvene next January.',
      'This has been noted in the minutes.',
    ],
    win: [
      'You will own nothing,| and you will be happy.',
      'The Great Reset requires sacrifices.| Yours.',
      'Welcome to Davos.',
      'The Fourth Industrial Revolution| will change everything about you.',
    ],
  },
};

/**
 * Draw from a shuffled bag so every line is used before any repeats.
 * A plain random pick is what makes a character sound like they only
 * know three sentences.
 */
export class LineBag {
  constructor() {
    this.pools = new Map();
  }

  /** @returns {string|{text,style}|null} */
  take(charId, category) {
    const lines = DIALOGUE[charId]?.[category];
    if (!lines || !lines.length) return null;
    const key = `${charId}.${category}`;
    let pool = this.pools.get(key);
    if (!pool || !pool.length) {
      pool = lines.slice();
      // Fisher-Yates. Presentation only, so Math.random is fine here.
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      // Avoid repeating the line we just used across a reshuffle.
      const last = this.pools.get(key + '.last');
      if (last && pool.length > 1 && sameLine(pool[pool.length - 1], last)) {
        [pool[0], pool[pool.length - 1]] = [pool[pool.length - 1], pool[0]];
      }
      this.pools.set(key, pool);
    }
    const picked = pool.pop();
    this.pools.set(key + '.last', picked);
    return picked;
  }
}

function sameLine(a, b) {
  const t = (x) => (typeof x === 'string' ? x : x?.text);
  return t(a) === t(b);
}

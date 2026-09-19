import { crops, escapeHtml } from './ui.js';
import { summarizeObservations } from './journal.js';

export const journalCopy = {
  ru: {
    title: '📈 Мои наблюдения', choose: 'Выберите прежний осмотр. Покажу его фото, затем попрошу новый снимок того же растения или участка.',
    empty: 'Сохранённых осмотров пока нет. Отправьте фото растения — результат появится здесь.',
    next: 'Дальше →', back: '← Назад', manual: 'Сравнить два снимка вручную',
    selected: 'Это выбранный снимок. Отправьте новое фото того же растения или участка. В подписи укажите дату съёмки и что изменилось. Старайтесь повторить ракурс и освещение.',
    missing: 'Эта запись больше недоступна. Откройте «Наблюдение» и выберите другую.',
    unavailable: 'История сейчас недоступна. Попробуйте позже.',
    saveFailed: 'Результат готов, но сохранить осмотр в историю не удалось. Попробуйте позже.',
    saveNotice: 'Осмотры сохраняются в истории: дата, описание, результат и ссылка на фото Telegram. Позже можно выбрать запись и сравнить её с новым снимком. /delete удаляет историю бота.',
    disabled: 'Сводка появится после подключения истории наблюдений.',
    analytics: '📊 Сводка моих осмотров', total: 'Осмотров', urgent: 'Рекомендован осмотр агронома сегодня', uncertain: 'Недостаточно данных',
    crop: 'По культурам', trends: 'Сравнения снимков', improved: 'Улучшение', stable: 'Без явных изменений', worse: 'Ухудшение', unknown: 'Динамика не установлена',
    note: 'Сводка описывает отправленные снимки, а не всё поле. Повторные осмотры учитываются отдельно. Это оценки ИИ; история не измеряет рост в сантиметрах или урожайность.',
    scope: 'Последние 100 сохранённых осмотров.', period: 'Период отправки',
    privacy: 'История: в базе сохраняются ссылка на фото Telegram, дата отправки, подпись, культура и результат до команды /delete. Само фото повторно загружается из Telegram при сравнении. Удаление записей бота не удаляет сообщения в вашем чате Telegram.',
    intro: 'Не нужно знать названия болезней. Опишите своими словами, что заметили: помогу понять, что проверить и когда обратиться к агроному.',
  },
  kk: {
    title: '📈 Менің бақылауларым', choose: 'Бұрынғы тексеруді таңдаңыз. Оның суретін көрсетіп, сол өсімдіктің не учаскенің жаңа суретін сұраймын.',
    empty: 'Сақталған тексеру жоқ. Өсімдіктің суретін жіберіңіз — нәтиже осында пайда болады.',
    next: 'Келесі →', back: '← Артқа', manual: 'Екі суретті қолмен салыстыру',
    selected: 'Бұл — таңдалған сурет. Сол өсімдіктің немесе учаскенің жаңа суретін жіберіңіз. Сипаттамада түсірілген күн мен өзгерістерді жазыңыз. Бұрыш пен жарықты қайталауға тырысыңыз.',
    missing: 'Бұл жазба қолжетімсіз. «Бақылау» бөлімінен басқасын таңдаңыз.',
    unavailable: 'Бақылау тарихы қазір қолжетімсіз. Кейін қайталаңыз.',
    saveFailed: 'Нәтиже дайын, бірақ тексеру тарихқа сақталмады. Кейін қайталаңыз.',
    saveNotice: 'Тексерулер тарихта сақталады: күн, сипаттама, нәтиже және Telegram суретінің сілтемесі. Кейін жазбаны таңдап, жаңа суретпен салыстыруға болады. /delete бот тарихын өшіреді.',
    disabled: 'Жиынтық бақылау тарихы қосылғаннан кейін пайда болады.',
    analytics: '📊 Менің тексерулерім', total: 'Тексерулер', urgent: 'Бүгін агроном тексеруі ұсынылған', uncertain: 'Дерек жеткіліксіз',
    crop: 'Дақылдар бойынша', trends: 'Суреттерді салыстыру', improved: 'Жақсару', stable: 'Айқын өзгеріс жоқ', worse: 'Нашарлау', unknown: 'Динамика анықталмады',
    note: 'Жиынтық бүкіл егістікті емес, жіберілген суреттерді сипаттайды. Қайталанған тексерулер жеке есептеледі. Бұл — ЖИ бағалауы; тарих сантиметрлік өсімді немесе өнімділікті өлшемейді.',
    scope: 'Соңғы 100 сақталған тексеру.', period: 'Жіберілген кезең',
    privacy: 'Тарих: базада Telegram суретінің сілтемесі, жіберілген күні, сипаттамасы, дақыл және нәтиже /delete командасына дейін сақталады. Салыстыру кезінде сурет Telegram-нан қайта жүктеледі. Бот жазбаларын өшіру Telegram чатындағы хабарламаларды өшірмейді.',
    intro: 'Ауру атауларын білу міндетті емес. Байқағаныңызды өз сөзіңізбен сипаттаңыз: нені тексеру және агрономға қашан жүгіну керегін түсіндіремін.',
  },
};
export const observationDate = date => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(date));
export function observationKeyboard(rows, page, lang) {
  const t = journalCopy[lang];
  const buttons = rows.slice(0, 5).map(row => [{ text: `${observationDate(row.created_at)} · ${crops[row.crop]?.[lang === 'kk' ? 1 : 0] || row.crop} · ${row.caption || row.assessment.title}`.slice(0, 110), callback_data: `saved:${row.id}` }]);
  const nav = [];
  if (page > 0) nav.push({ text: t.back, callback_data: `observe:page:${page - 1}` });
  if (rows.length > 5) nav.push({ text: t.next, callback_data: `observe:page:${page + 1}` });
  if (nav.length) buttons.push(nav);
  buttons.push([{ text: t.manual, callback_data: 'observe:manual' }]);
  return { inline_keyboard: buttons };
}
export function renderAnalytics(rows, lang, limited = false) {
  const t = journalCopy[lang], s = summarizeObservations(rows), e = escapeHtml;
  if (!rows.length) return t.empty;
  const dates = rows.map(row => row.created_at).sort();
  return `<b>${t.analytics}</b>\n${limited ? t.scope + '\n' : ''}${t.period}: ${observationDate(dates[0])} — ${observationDate(dates.at(-1))}`
    + `\n\n${t.total}: ${s.count}\n${t.uncertain}: ${s.uncertain}\n${t.urgent}: ${s.urgent}`
    + `\n\n<b>${t.crop}</b>\n${Object.entries(s.crops).map(([crop, count]) => `${e(crops[crop]?.[lang === 'kk' ? 1 : 0] || crop)}: ${count}`).join('\n')}`
    + `\n\n<b>${t.trends}</b>\n${t.improved}: ${s.trends.improved}\n${t.stable}: ${s.trends.stable}\n${t.worse}: ${s.trends.worse}\n${t.unknown}: ${s.trends.uncertain}\n\n<i>${t.note}</i>`;
}

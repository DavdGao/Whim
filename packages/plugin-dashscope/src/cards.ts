import { validateTextCard } from '@whimkit/models';

import model3 from './cards/deepseek-v4-pro-0813.json' with { type: 'json' };
import model2 from './cards/deepseek-v4.1-flash.json' with { type: 'json' };
import model4 from './cards/glm-5.3-prime.json' with { type: 'json' };
import model5 from './cards/kimi-k3.json' with { type: 'json' };
import model1 from './cards/qwen3.8-flash.json' with { type: 'json' };
import model0 from './cards/qwen3.8-max.json' with { type: 'json' };

export const cards = [model0, model1, model2, model3, model4, model5].map(value =>
    validateTextCard(value)
);
export const card = cards[0];

# PlayerZero JavaScript SDK

## Installation

```bash
npm i @goplayerzero/js-api --save
```

## Usage

```javascript
import { PzApi } from '@goplayerzero/js-api';

const pz = PzApi.getInstance('<apiToken>');
pz.identify('<userId>', { '<optional>': '<properties>' });
pz.track('Add to Cart');
pz.signal('Insufficient Funds', { type: 'Bank Error' });
pz.withIdentify({ Account: 'Vanderlay Industries' }, { billing: 'net30' }, () => {
  // temporary change of identity from user to Subscription for purpose of side activity
  // do stuff, identity will revert back at the end of this funtion
});
```

## Example of Express Integration

For any application wishing to maintain identity across async hooks (like for example express handling web server
requests where each request is a different person), node's async storage must be integrated around the auth handling
piece of the express code. For example, as super simple typescript auth manager might look like,

```typescript
import { PzApi } from '@goplayerzero/js-api';
import { AsyncLocalStorage } from 'async_hooks';
import { NextFunction, Request, Response } from 'express';
import { getUser, User } from './lib/get-user.js';

const asyncLocalStorage = new AsyncLocalStorage<User>();

const pzApi = PzApi.getInstance('<your api token here>', {
  dataset: 'my-express-app',
  prod: false,
  intercept: console, // to auto-capture all console log, debug, info, warn, error outputs
});

// Instrumentation to wrap our event identity association on a per async call
const originalPendingEvent = pzApi.pendingEvent.bind(pzApi);
pzApi.pendingEvent = type => {
  const id = asyncLocalStorage.getStore();
  return originalPendingEvent(type).identify(id?.userId, { name: id?.name, tenantId: id?.tenantId });
};

// Example of the already existing express auth handler
export const authManager = (req: Request, res: Response, next: NextFunction) => {
  const user: User | undefined = getUser(req.headers.authorization);
  // wrap the next() in the asyncLocalStorage with the identity information desired
  asyncLocalStorage.run(user, () => next());
};
```

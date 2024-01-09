# trace-dojo

[![Test](https://github.com/exKAZUu-Research/trace-dojo/actions/workflows/test.yml/badge.svg)](https://github.com/exKAZUu-Research/trace-dojo/actions/workflows/test.yml)

An educational web app for training program tracing skills.

## Getting Started

### Installation

1. Clone the repo

```
git clone git@github.com:exKAZUu-Research/trace-dojo.git
```

1. yarn

```
yarn install
```

1. Create `.env`

```
cp .env.development .env
```

1. Sync database schema

```
npx prisma migrate dev
```

### Start Development

1. Start Next Server

```
yarn start
```

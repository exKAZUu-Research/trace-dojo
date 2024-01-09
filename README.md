# trace-dojo

[![Test](https://github.com/exKAZUu-Research/trace-dojo/actions/workflows/test.yml/badge.svg)](https://github.com/exKAZUu-Research/trace-dojo/actions/workflows/test.yml)

An educational web app for training program tracing skills.

## Getting Started

### Installation

1. Clone the repo

   ```
   git clone git@github.com:exKAZUu-Research/trace-dojo.git
   ```

1. Install dependencies

   ```
   yarn install
   ```

1. Reset local database by applying migration files and adding initial records

   ```
   yarn db-reset
   ```

### Start Development

1. Start Next server

   ```
   yarn start
   ```

### Change Database Schema

1. Change `prisma/schema.prisma`

1. Create migration files on the basis of `prisma/schema.prisma`

   ```
   yarn db-migrate-create
   ```

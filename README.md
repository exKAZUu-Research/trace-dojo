# trace-dojo

[![Test](https://github.com/exKAZUu-Research/trace-dojo/actions/workflows/test.yml/badge.svg)](https://github.com/exKAZUu-Research/trace-dojo/actions/workflows/test.yml)
[![Deploy staging](https://github.com/exKAZUu-Research/trace-dojo/actions/workflows/deploy-staging.yml/badge.svg)](https://github.com/exKAZUu-Research/trace-dojo/actions/workflows/deploy-staging.yml)
[![Deploy production](https://github.com/exKAZUu-Research/trace-dojo/actions/workflows/deploy-production.yml/badge.svg)](https://github.com/exKAZUu-Research/trace-dojo/actions/workflows/deploy-production.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)

An educational web app for training program tracing skills.

## Releases

- Staging: https://trace-dojo-staging.fly.dev/
- Production: https://trace-dojo.fly.dev/

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

2. Open lectures via the following URLs:

   - 初級プログラミングⅠ
     1. http://localhost:3000/courses/tuBeginner1/lectures/8d692b48-8c19-4679-8d8f-3f27a051d44d
     2. http://localhost:3000/courses/tuBeginner1/lectures/d4de75e2-758b-4500-b38e-96213c360527
     3. http://localhost:3000/courses/tuBeginner1/lectures/99045fdf-6cb5-4947-b934-8b1bc5831bbd
     4. http://localhost:3000/courses/tuBeginner1/lectures/37632776-e3ab-4cc5-ae08-934caf2ada53
     5. http://localhost:3000/courses/tuBeginner1/lectures/8fbc94d3-d20c-4457-8997-61e85b3516d9
     6. http://localhost:3000/courses/tuBeginner1/lectures/35957643-c106-4a97-8073-6705c39ab9a6
     7. http://localhost:3000/courses/tuBeginner1/lectures/045094ae-1f5c-4caf-bc33-a86af985f13b
     8. http://localhost:3000/courses/tuBeginner1/lectures/84805179-12cf-4871-969e-fb39e6ad767a
   - 初級プログラミングⅡ
     1. http://localhost:3000/courses/tuBeginner2/lectures/8d692b48-8c19-4679-8d8f-3f27a051d44d
     2. http://localhost:3000/courses/tuBeginner2/lectures/d4de75e2-758b-4500-b38e-96213c360527
     3. http://localhost:3000/courses/tuBeginner2/lectures/99045fdf-6cb5-4947-b934-8b1bc5831bbd
     4. http://localhost:3000/courses/tuBeginner2/lectures/37632776-e3ab-4cc5-ae08-934caf2ada53
     5. http://localhost:3000/courses/tuBeginner2/lectures/8fbc94d3-d20c-4457-8997-61e85b3516d9
     6. http://localhost:3000/courses/tuBeginner2/lectures/35957643-c106-4a97-8073-6705c39ab9a6
     7. http://localhost:3000/courses/tuBeginner2/lectures/045094ae-1f5c-4caf-bc33-a86af985f13b
     8. http://localhost:3000/courses/tuBeginner2/lectures/84805179-12cf-4871-969e-fb39e6ad767a
   - 動作確認用
     1. http://localhost:3000/courses/test/lectures/8d692b48-8c19-4679-8d8f-3f27a051d44d

   The URL format is as follows.
   You can find parameter values from `NEXT_PUBLIC_COURSE_ID_TO_LECTURE_IDS_JSON` in the `.env` file.

   ```
   http://localhost:3000/courses/[courseId]/lectures/[lectureId]
   ```

### Change Database Schema

1. Change `prisma/schema.prisma`

1. Create migration files on the basis of `prisma/schema.prisma`

   ```
   yarn db-migrate-create
   ```

### How to Create Problems

[新問題の作問手順](./HOW_TO_CREATE_PROBLEMS.md)を読んでください。

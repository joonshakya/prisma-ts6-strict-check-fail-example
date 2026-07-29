import { db } from './src/prisma/db'

async function main() {
  const posts = await db.orm.public.Post.select('id', 'name', 'nonExistentField').all()

  posts.forEach((post) => {
    console.log(post.name, post.nonExistentField)
  })
}

main()

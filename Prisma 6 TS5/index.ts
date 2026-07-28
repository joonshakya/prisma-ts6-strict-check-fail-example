import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const posts = await prisma.post.findMany({
    select: {
      id: true,
      name: true,
      nonExistentField: true,
    },
  })

  posts.forEach((post) => {
    console.log(post.name, post.nonExistentField)
  })
}

main()

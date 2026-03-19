let getUser = %generated.typesql(`
  /* @name GetUser */
  select id, name from users where id = :id
`)

module RenameUser = %generated.typesql(`
  /* @name RenameUser */
  update users set name = :name where id = :id
`)

let run = db => {
  let before = getUser(db, {id: 1})
  let _ = RenameUser.query(db, {name: "Grace"}, {id: 1})
  let after = getUser(db, {id: 1})
  (before, after)
}
